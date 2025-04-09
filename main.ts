import {
  Plugin,
  Modal,
  App,
  Setting,
  TFile,
  EditorTransaction,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  IndexNotesSettings,
  IndexNotesSettingTab,
} from "src/settings/Settings";
import { IndexUpdater } from "src/indexer";
import dateFormat from "dateformat";
import YAML from "yaml";

const DATE_FORMAT = "yyyy-mm-dd";
const MARKDOWN_EXTENSION = ".md";

export default class IndexNotesPlugin extends Plugin {
  settings: IndexNotesSettings;
  index_updater: IndexUpdater;
  debounceTimer: NodeJS.Timeout | null = null;
  lastModified: number = 0; // Track when the last modification occurred
  modifiedFile: TFile | null = null; // Track which file was modified
  activeEditing: boolean = false; // Track if user is actively editing
  pendingUpdate: boolean = false; // Track if an update is waiting to be triggered
  fileTagCache: Map<string, Set<string>> = new Map(); // Cache to track tags for each file

  // Debounced update method to prevent excessive updates
  private debouncedUpdate(changedFile: TFile | null = null): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      // Only perform update if enough time has passed since the last modification
      const currentTime = Date.now();
      if (currentTime - this.lastModified >= 5000 || !this.modifiedFile) {
        console.log("Debounced update triggered - sufficient time has passed");
        this.index_updater.update(changedFile || this.modifiedFile);
        this.modifiedFile = null;
      } else {
        console.log("Skipping update - still actively editing");
      }

      this.debounceTimer = null;
      this.pendingUpdate = false;
    }, this.settings.update_interval_seconds);
  }

  async onload() {
    await this.loadSettings();

    this.index_updater = new IndexUpdater(this.app, this.settings);

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.enable_auto_update) {
        if (this.settings.granular_updates) {
          // Set up a 5-second inactivity timer to trigger updates
          this.registerInterval(
            window.setInterval(() => {
              const currentTime = Date.now();
              if (this.modifiedFile && currentTime - this.lastModified >= 5000) {
                console.log("Inactivity timer: updating after 5 seconds of no changes");
                this.index_updater.update(this.modifiedFile);
                this.modifiedFile = null;
              }
            }, 1000) // Check every second
          );

          // Update the index notes when changes are made to the vault
          this.registerEvent(
            this.app.vault.on("modify", (file) => {
              if (!file || !(file instanceof TFile)) return;
              console.log("index_tag: file modified", file.path);

              // Update the last modified time and file
              this.lastModified = Date.now();
              this.modifiedFile = file;

              // We don't trigger update immediately - the inactivity timer will handle it
            })
          );

          // For non-editing events, trigger updates immediately
          this.registerEvent(
            this.app.vault.on("delete", (file) => {
              if (!file || !(file instanceof TFile)) return;
              console.log("index_tag: file deleted", file.path);
              this.index_updater.update(file);
            })
          );
          this.registerEvent(
            this.app.vault.on("rename", (file) => {
              if (!file || !(file instanceof TFile)) return;
              console.log("index_tag: file renamed", file.path);
              this.index_updater.update(file);
            })
          );
          this.registerEvent(
            this.app.vault.on("create", (file) => {
              if (!file || !(file instanceof TFile)) return;
              console.log("index_tag: file created", file.path);
              this.index_updater.update(file);
            })
          );
        } else {
          // Setup the update interval if auto-update is enabled
          const interval_ms = this.settings.update_interval_seconds * 1000;

          // Use registerInterval instead of setInterval
          this.registerInterval(
            window.setInterval(() => {
              console.log("Auto-update interval triggered");
              this.index_updater.update();
            }, interval_ms)
          );
          console.log(
            `Set up auto-update interval: ${this.settings.update_interval_seconds} seconds`
          );
        }
      } else {
        console.log("Auto-update is disabled. Only manual updates will occur.");
        // Add event listener for file opens
        this.registerEvent(
          this.app.workspace.on("file-open", (file) => {
            if (!file) return;

            // Get file metadata
            const metadata = this.app.metadataCache.getFileCache(file);
            console.log("index_tag: file opened", file.path, metadata);
            if (!metadata || !metadata.frontmatter) return;

            const tags = metadata.frontmatter.tags || [];

            console.log("index_tag: found tags", tags);
            console.log(
              "index_tag: settings",
              this.settings.index_tag,
              this.settings.meta_index_tag
            );
            // Check if any tags have "idx" in them
            const hasIdxTags: boolean = tags.some((tag: string) =>
              tag.includes(this.settings.index_tag)
            );
            console.log("index_tag: has idx tags:", hasIdxTags);

            // Check if this file has index tags
            if (
              tags.some(
                (tag: string) =>
                  tag.includes(this.settings.index_tag) ||
                  tag.includes(this.settings.meta_index_tag)
              )
            ) {
              // Only update when an index note is opened
              console.log("Index note opened, updating index");
              this.index_updater.update();
            }
          })
        );
      }
    });

    this.addSettingTab(new IndexNotesSettingTab(this.app, this));

    this.addCommand({
      id: "new-note-same-loc-and-tags",
      name: "New note with same location and tags",
      callback: async () => {
        await this.newNoteFromFocusedFile();
      },
    });

    // This creates an icon in the left ribbon.
    const ribbonIconEl = this.addRibbonIcon(
      "copy-plus",
      "New note by copying metadata of focused note",
      async () => {
        await this.newNoteFromFocusedFile();
      }
    );
  }

  onunload() {
    // No need for clear_update_interval as registerInterval handles cleanup
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async createFileWithContentAndOpen(
    newFilePath: string,
    fileContent: string,
    metadata: Object
  ) {
    try {
      let new_file = await this.app.vault.create(newFilePath, fileContent);
      await this.app.workspace.getLeaf(true).openFile(new_file, {
        active: true,
        state: {
          mode: "source",
        },
      });

      await this.app.fileManager.processFrontMatter(new_file, (fm) => {
        for (const [key, value] of Object.entries(metadata)) {
          fm[key] = value;
        }
        return fm;
      });
    } catch (error) {
      console.error("Error creating or processing new file:", error);
    }
  }

  async newNoteFromFocusedFile() {
    let ref_file = this.app.workspace.activeEditor?.file;
    if (!ref_file) {
      return;
    }

    let current_filepath = ref_file.path;
    let parent_dir = ref_file.parent?.path;
    let metadata_cache = this.app.metadataCache.getCache(current_filepath);
    let file_tags: string[] = [];
    if (metadata_cache?.frontmatter) {
      file_tags = metadata_cache.frontmatter.tags;
      file_tags = file_tags.filter((t) => t !== this.settings.index_tag);
    }

    let now = new Date();
    let new_file_metadata: Object;
    try {
      new_file_metadata = YAML.parse(
        this.settings.metadata_template
          .replace("{{today}}", dateFormat(now, DATE_FORMAT))
          .replace("{{tags}}", file_tags.join(", "))
      );
    } catch (error) {
      console.error("Error parsing YAML metadata:", error);
      return;
    }

    new PromptModal(this.app, "New note title", async (result) => {
      let new_file_path = `${parent_dir}/${result}${MARKDOWN_EXTENSION}`;
      try {
        this.createFileWithContentAndOpen(new_file_path, "", new_file_metadata);
      } catch (error) {
        console.error("Error creating and opening file:", error);
      }
    }).open();
  }
}

class PromptModal extends Modal {
  result: string;
  prompt: string;
  onSubmit: (result: string) => void;

  constructor(app: App, prompt: string, onSubmit: (result: string) => void) {
    super(app);
    this.prompt = prompt;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    try {
      this.titleEl.innerText = this.prompt;

      let settingEl = new Setting(this.contentEl).addText((text) => {
        text.onChange((value) => {
          this.result = value;
        });
        text.setPlaceholder("");
        text.inputEl.addEventListener("keydown", (evt) =>
          this.enterCallback(evt)
        );
        text.inputEl.addClass("index-notes-prompt-modal-input");
      });
      settingEl.infoEl.remove();
      settingEl.settingEl.focus();
    } catch (error) {
      console.error("Error setting up modal elements:", error);
    }
  }

  enterCallback(evt: any) {
    try {
      if (evt.key === "Enter" && this.result.length) {
        this.close();
        this.onSubmit(this.result);
      }
    } catch (error) {
      console.error("Error handling enter key press:", error);
    }
  }
}
