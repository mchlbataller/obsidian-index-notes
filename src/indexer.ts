import { App, PluginSettingTab, TFile } from "obsidian";
import IndexNotesPlugin from "main";
import { IndexNotesSettings } from "src/settings/Settings";
import { title } from "process";

function stringHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return String(hash);
}

function formatTagWord(tagWord: string): string {
  // Only remove leading underscore but preserve case
  return tagWord.startsWith("_") ? tagWord.slice(1) : tagWord;
}

function capitalizeFirst(s: string): string {
  // Keep this function as is to ensure the first letter is capitalized
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Splits tags into words and formats by removing leading underscores but preserving case.
 * E.g.: tag "__RL_and__ML" would become "RL and ML"
 *
 * @param {string} t - The tag string to be formatted into a header.
 * @returns {string} The formatted header string.
 */
function tagToHeader(t: string): string {
  return t
    .split("/")
    .map((component) => {
      const words = component
        .split("_")
        .map((word, index, arr) => {
          if (word === "") {
            return "";
          }

          if (index > 0 && arr[index - 1] === "") {
            return formatTagWord("_" + word);
          }
          return formatTagWord(word);
        })
        .filter((word) => word !== "");

      // Only capitalize the first letter of the whole component, preserve case of other words
      return words.join(" ");
    })
    .join(" / ");
}

function tagToBlockReference(tag: string = "main-index"): string {
  if (tag.length === 0) {
    return "^indexof-root000";
  }
  return "^" + ("indexof-" + tag).replace(/[^a-zA-Z]+/g, "-");
}

function getBlockRegex(blockRef: string): RegExp {
  // Original regex still needed for backward compatibility with old format
  return new RegExp(
    `(?:^(?:>\\s*\\[!example\\].*\\n)(?:>.*\\n)*(?:>\\s*\\${blockRef}$))|(?:^#+\\s+.*\\n(?:(?!^#)[\\s\\S])*?\\s*${blockRef})`,
    "gm"
  );
}

// Add these constants at the top level of the file
const INDEX_START_MARKER = "%% start index notes %%";
const INDEX_END_MARKER = "%% end index notes %%";
const META_INDEX_START_MARKER = "%% start meta-index notes %%";
const META_INDEX_END_MARKER = "%% end meta-index notes %%";

// Add a function to detect the new marker format
function getMarkerBlockRegex(): RegExp {
  return new RegExp(
    `${INDEX_START_MARKER}[\\s\\S]*?${INDEX_END_MARKER}|${META_INDEX_START_MARKER}[\\s\\S]*?${META_INDEX_END_MARKER}`,
    "gm"
  );
}

function filenameToHeader(filename: string): string {
  // Remove file extension (like .md) if present
  return filename.split(".")[0];
}

function getLastTagComponent(tagPath: string): string {
  return tagPath.split("/").pop()!;
}

function canonicalizeTag(tag: string): string {
  return tag.trim().replace(/^\/|\/$/g, "");
}

function getNoteTitle(note: TFile, app: App, prefix: string = ""): string {
  const noteTitle = app.metadataCache.getCache(note.path)?.frontmatter?.title;
  return noteTitle
    ? prefix +
        (noteTitle.length > 50 ? noteTitle.substring(0, 50) + "..." : noteTitle)
    : "";
}

function sortable(s: string): string {
  return s
    .replace(
      /[^A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔΦΓΛΩΠΘΣΘΞÆæßÉ!"#$%&'()*+,\-.\/:;<=>;?¡ÄÖÑÜ§¿äöñüà^{}\[\~\]\|\€\\]/g,
      ""
    )
    .trim()
    .toLowerCase();
}

function compareStrings(a: string, b: string): number {
  const sA = sortable(a);
  const sB = sortable(b);
  return sA.localeCompare(sB);
}

class Node {
  tagPath: string;
  headerNote: TFile | undefined;
  regularNotes: TFile[] = [];
  priorityNotes: TFile[] = [];
  indexNotes: TFile[] = [];
  indexPriorityNotes: TFile[] = [];
  children: Node[] = [];
  settings: IndexNotesSettings;
  app: App;

  constructor(tagPath: string, settings: IndexNotesSettings, app: App) {
    this.tagPath = canonicalizeTag(tagPath);
    this.settings = settings;
    this.app = app;
  }

  getAllNotes(): TFile[] {
    return this.headerNote
      ? this.priorityNotes.concat(this.regularNotes, [this.headerNote])
      : this.priorityNotes.concat(this.regularNotes);
  }

  sortAll(): void {
    this.priorityNotes.sort((a, b) => compareStrings(a.name, b.name));
    this.regularNotes.sort((a, b) => compareStrings(a.name, b.name));
    this.indexNotes.sort((a, b) => compareStrings(a.name, b.name));
    this.children.sort((a, b) =>
      compareStrings(
        tagToHeader(a.tagComponent()),
        tagToHeader(b.tagComponent())
      )
    );
    this.children.forEach((child) => child.sortAll());
  }

  tagComponent(): string {
    return getLastTagComponent(this.tagPath);
  }

  hasOwnIndexNote(): boolean {
    return this.indexNotes.length > 0;
  }

  getIndex(indexNote: TFile, indentLevel: number = 0): string {
    let indexTxt = "";

    // Add notes directly belonging to this node level
    const notesToInclude = this.priorityNotes
      .concat(this.regularNotes, this.indexNotes)
      .filter((note) => note.path !== indexNote.path);

    if (notesToInclude.length > 0) {
      indexTxt += notesToInclude
        .map((note) => {
          const mdLink = this.app.fileManager.generateMarkdownLink(
            note,
            indexNote.path,
            undefined,
            filenameToHeader(note.name)
          );
          const noteTitle = getNoteTitle(note, this.app, ": ");

          // Format index notes in bold if bold_index_note_titles setting is enabled
          const isIndexNote = this.settings.bold_index_note_titles
            ? (() => {
                const tags = this.app.metadataCache.getCache(note.path)?.frontmatter?.tags;
                // Ensure tags is an array before calling filter and some
                if (Array.isArray(tags)) {
                  return tags
                    .filter((tag) => tag !== null && tag !== undefined)
                    .some((tag) => {
                      return String(tag).includes("idx");
                    });
                } else if (typeof tags === 'string') {
                  return tags.includes("idx");
                }
                return false;
              })()
            : false;
          const boldStart =
            this.priorityNotes.includes(note) || isIndexNote ? "**" : "";
          const boldEnd =
            this.priorityNotes.includes(note) || isIndexNote ? "**" : "";

          return `> ${"\t".repeat(
            indentLevel
          )}- ${boldStart}${mdLink}${noteTitle}${boldEnd}\n`;
        })
        .join("");
    }

    // Process each child node
    this.children.forEach((child) => {
      const childHasIndex = child.hasOwnIndexNote();
      const useHierarchy = this.settings.hierarchical_indices;
      const childIndexNotes = child.indexNotes.filter(
        (note) => note.path !== indexNote.path
      );

      // Different behavior based on the number of index notes in the child
      if (useHierarchy && childHasIndex) {
        if (childIndexNotes.length === 1) {
          // For exactly one index note, make the node itself link to the index
          const singleIndexNote = childIndexNotes[0];
          const headerText = child.headerNote
            ? filenameToHeader(child.headerNote.name)
            : tagToHeader(child.tagComponent());

          const mdLink = this.app.fileManager.generateMarkdownLink(
            singleIndexNote,
            indexNote.path,
            undefined,
            headerText
          );
          indexTxt += `> ${"\t".repeat(indentLevel)}- **${mdLink}**\n`;
        } else {
          // For multiple index notes, show the node header and list index notes beneath it
          const headerText = child.headerNote
            ? filenameToHeader(child.headerNote.name)
            : tagToHeader(child.tagComponent());

          // Create a link if there's a header note
          const mdLink = child.headerNote
            ? this.app.fileManager.generateMarkdownLink(
                child.headerNote,
                indexNote.path,
                undefined,
                headerText
              )
            : headerText;

          // Add the child header or link
          indexTxt += `> ${"\t".repeat(indentLevel)}- **${mdLink}**\n`;

          // List all index notes (all in bold since they are index notes)
          childIndexNotes.forEach((note) => {
            const displayText = filenameToHeader(note.name);
            const noteMdLink = this.app.fileManager.generateMarkdownLink(
              note,
              indexNote.path,
              undefined,
              displayText
            );
            indexTxt += `> ${"\t".repeat(
              indentLevel + 1
            )}- **${noteMdLink}**\n`;
          });
        }
      } else {
        // Not in hierarchical mode or child doesn't have index
        // Handle as before: show node and its full contents
        const headerText = child.headerNote
          ? filenameToHeader(child.headerNote.name)
          : tagToHeader(child.tagComponent());

        const mdLink = child.headerNote
          ? this.app.fileManager.generateMarkdownLink(
              child.headerNote,
              indexNote.path,
              undefined,
              headerText
            )
          : headerText;

        indexTxt += `> ${"\t".repeat(indentLevel)}- **${mdLink}**\n`;

        // Recursively include child content
        if (!useHierarchy || !childHasIndex) {
          indexTxt += child.getIndex(indexNote, indentLevel + 1);
        }
      }
    });

    return indexTxt;
  }

  getMetaIndex(indexNote: TFile): string {
    let indexTxt = "";
    const notes = new Set<TFile>();
    const priorityNotes = new Set<TFile>();

    this.children.forEach((child) => {
      child.indexNotes.forEach((note) => {
        if (note.path !== indexNote.path) notes.add(note);
      });
      child.indexPriorityNotes.forEach((note) => {
        if (note.path !== indexNote.path) priorityNotes.add(note);
      });
    });

    [...priorityNotes]
      .sort((a, b) => compareStrings(a.name, b.name))
      .forEach((note) => {
        const mdLink = this.app.fileManager.generateMarkdownLink(
          note,
          indexNote.path,
          undefined,
          filenameToHeader(note.name)
        );
        const noteTitle = getNoteTitle(note, this.app, ": ");
        indexTxt += `> \n> > [!tldr] ${mdLink}${noteTitle}\n`;
      });

    [...notes]
      .sort((a, b) => compareStrings(a.name, b.name))
      .forEach((note) => {
        const mdLink = this.app.fileManager.generateMarkdownLink(
          note,
          indexNote.path,
          undefined,
          filenameToHeader(note.name)
        );
        const noteTitle = getNoteTitle(note, this.app, ": ");
        indexTxt += `> \n> > [!example] ${mdLink}${noteTitle}\n`;
      });

    return indexTxt;
  }

  findChildNode(tagPath: string): Node | undefined {
    tagPath = canonicalizeTag(tagPath);
    if (tagPath === this.tagPath) {
      return this;
    } else if (tagPath.startsWith(this.tagPath)) {
      const nextComponent = canonicalizeTag(
        tagPath.slice(this.tagPath.length)
      ).split("/")[0];
      const child = this.children.find(
        (child) => child.tagComponent() === nextComponent
      );
      return child ? child.findChildNode(tagPath) : undefined;
    }
    console.error('Did not find node at path "' + tagPath + '"');
    return undefined;
  }

  addNoteWithPath(
    tagPath: string,
    note: TFile,
    hasPriority: boolean,
    isIndex: boolean
  ): boolean {
    tagPath = canonicalizeTag(tagPath);
    if (tagPath === this.tagPath) {
      if (isIndex && hasPriority) {
        this.indexPriorityNotes.push(note);
      } else if (isIndex) {
        this.indexNotes.push(note);
      } else if (
        filenameToHeader(note.name) === tagToHeader(this.tagComponent())
      ) {
        this.headerNote = note;
      } else if (hasPriority) {
        this.priorityNotes.push(note);
      } else {
        this.regularNotes.push(note);
      }
      return true;
    } else if (tagPath.startsWith(this.tagPath)) {
      const nextComponent = canonicalizeTag(
        tagPath.slice(this.tagPath.length)
      ).split("/")[0];
      let child = this.children.find(
        (child) => child.tagComponent() === nextComponent
      );
      if (child) {
        return child.addNoteWithPath(tagPath, note, hasPriority, isIndex);
      }
      const nextTagPath = this.tagPath
        ? `${this.tagPath}/${nextComponent}`
        : nextComponent;
      const newNode = new Node(nextTagPath, this.settings, this.app);
      const success = newNode.addNoteWithPath(
        tagPath,
        note,
        hasPriority,
        isIndex
      );
      if (!success) {
        console.error(
          "Could not add path for note: ",
          tagPath + "|" + nextTagPath,
          this
        );
      }
      this.children.push(newNode);
      return success;
    }
    return false;
  }

  getHash(): string {
    const toHash =
      this.getAllNotes()
        .map((n) => n.path)
        .join() +
      this.tagPath +
      this.children.map((c) => c.getHash()).join();
    return stringHash(toHash);
  }
}

class IndexNote {
  note: TFile;
  indexTags: string[] = [];
  metaIndexTags: string[] = [];
  app: App;
  settings: IndexNotesSettings;

  constructor(note: TFile, app: App, settings: IndexNotesSettings) {
    this.note = note;
    this.app = app;
    this.settings = settings;
  }

  getHash(): string {
    this.sortIndexTags();
    const toHash = `INDEX:${String(
      this.indexTags.length
    )}${this.indexTags.join()}META:${String(
      this.metaIndexTags.length
    )}${this.metaIndexTags.join()}`;
    return stringHash(toHash);
  }

  makeIndexTitle(rootTag: string, prefix: string): string {
    // If omit_index_titles is enabled, return empty string
    if (this.settings.omit_index_titles) {
      return "";
    }
    return prefix + tagToHeader(rootTag) + "\n";
  }

  sortIndexTags(): void {
    this.indexTags.sort((a, b) =>
      compareStrings(getLastTagComponent(a), getLastTagComponent(b))
    );
    this.metaIndexTags.sort((a, b) =>
      compareStrings(getLastTagComponent(a), getLastTagComponent(b))
    );
  }

  createIndexBlocks(rootNode: Node): Array<[string, string]> {
    this.sortIndexTags();
    const indexBlocks: Array<[string, string]> = [];

    // Regular index blocks
    if (this.indexTags.length > 0) {
      let allIndexContent = "";

      // Generate heading markers based on settings
      const headingPrefix = this.settings.use_heading_for_index
        ? "#".repeat(this.settings.heading_level) + " "
        : "";

      this.indexTags.forEach((indexTag) => {
        let blockText = "";
        const title = this.makeIndexTitle(indexTag, "");

        if (this.settings.use_callout_blocks) {
          // Callout block format
          // For callout blocks, we should still include a title indicator even if titles are omitted
          const calloutTitle = this.settings.omit_index_titles
            ? "Index"
            : title.trim();
          blockText = `> [!example] ${calloutTitle}`;

          const sourceNote = rootNode.findChildNode(indexTag);
          if (sourceNote) {
            // Need a newline after the title if title is not omitted
            if (!this.settings.omit_index_titles) {
              blockText += "\n";
            }
            blockText += sourceNote.getIndex(this.note);
          }
          blockText += `> \n`;
        } else {
          // Plain list format
          if (!this.settings.omit_index_titles) {
            blockText = `${headingPrefix}${title}`;
          }

          const sourceNote = rootNode.findChildNode(indexTag);
          if (sourceNote) {
            // Remove the '>' prefix from each line for regular indexes
            const indexContent = sourceNote.getIndex(this.note);
            blockText += indexContent.replace(/^> /gm, "");
          }
        }

        allIndexContent += blockText + "\n";
      });

      // Wrap all index blocks in markers
      const formattedIndexBlock = `${INDEX_START_MARKER}\n${allIndexContent}${INDEX_END_MARKER}`;
      indexBlocks.push(["index", formattedIndexBlock]);
    }

    // Meta index blocks
    if (this.metaIndexTags.length > 0) {
      let allMetaIndexContent = "";

      this.metaIndexTags.forEach((indexTag) => {
        // For meta-indices, use at least "Meta-index" as title even if titles are omitted
        const metaTitle = this.settings.omit_index_titles
          ? "Meta-index"
          : this.makeIndexTitle(
              indexTag,
              indexTag ? "Meta-index of: " : "Meta-index"
            );

        let blockText = `> [!example] ${metaTitle}`;

        const sourceNote = rootNode.findChildNode(indexTag);
        if (sourceNote) {
          blockText += sourceNote.getMetaIndex(this.note);
        }
        blockText += `> \n`;

        allMetaIndexContent += blockText + "\n";
      });

      // Wrap all meta-index blocks in markers
      const formattedMetaIndexBlock = `${META_INDEX_START_MARKER}\n${allMetaIndexContent}${META_INDEX_END_MARKER}`;
      indexBlocks.push(["meta-index", formattedMetaIndexBlock]);
    }

    return indexBlocks;
  }

  getUpdatedContent(
    content: string,
    indexBlocks: Array<[string, string]>
  ): string {
    try {
      // Split the file content to separate frontmatter
      const frontmatterMatch = content.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n/);
      const frontmatter = frontmatterMatch ? frontmatterMatch[0] : "";

      // Remove frontmatter from content for processing
      let mainContent = frontmatterMatch
        ? content.substring(frontmatter.length)
        : content;

      // First handle old-style index blocks (remove them as they'll be replaced with new format)
      const existingBlockRefs = Array.from(
        mainContent.matchAll(/\^indexof-(?:[a-zA-Z0-9]+-?)+/g)
      ).map((match) => match[0]);

      for (const blockRef of existingBlockRefs) {
        const blockRegex = getBlockRegex(blockRef);
        mainContent = mainContent.replace(blockRegex, "");
      }

      // Track if we've updated each type of block
      let indexBlockUpdated = false;
      let metaIndexBlockUpdated = false;

      // Find and update marker-style index blocks in-place
      for (const [blockType, blockContent] of indexBlocks) {
        const isMetaIndex = blockType === "meta-index";
        const startMarker = isMetaIndex
          ? META_INDEX_START_MARKER
          : INDEX_START_MARKER;
        const endMarker = isMetaIndex
          ? META_INDEX_END_MARKER
          : INDEX_END_MARKER;

        // Check if this type of block already exists in the content
        const blockRegex = new RegExp(
          `${startMarker}[\\s\\S]*?${endMarker}`,
          "gm"
        );

        if (mainContent.match(blockRegex)) {
          // Replace content between markers while keeping the markers in the same position
          mainContent = mainContent.replace(blockRegex, blockContent);

          // Mark this block type as updated
          if (isMetaIndex) {
            metaIndexBlockUpdated = true;
          } else {
            indexBlockUpdated = true;
          }
        }
      }

      // Clean up any excessive newlines that might have been created
      // Commenting this out for now to avoid removing newlines that might be needed
      // mainContent = mainContent.replace(/\n{3,}/g, "\n\n");

      // Add any blocks that weren't already in the document
      let result = mainContent;
      for (const [blockType, blockContent] of indexBlocks) {
        const isMetaIndex = blockType === "meta-index";

        // Only add blocks that weren't updated in-place
        if (
          (isMetaIndex && !metaIndexBlockUpdated) ||
          (!isMetaIndex && !indexBlockUpdated)
        ) {
          // Make sure there are always two newlines before each new block
          if (result.length > 0 && !result.endsWith("\n\n")) {
            result += result.endsWith("\n") ? "\n" : "\n\n";
          }
          result += blockContent;
        }
      }

      // Put the frontmatter back at the beginning
      return frontmatter + result;
    } catch (error) {
      console.error("Error updating content:", error);
      return content; // Return original content on error
    }
  }
}

class IndexSchema {
  indexNotes: IndexNote[] = [];
  rootNode: Node;

  getHash(): string {
    return stringHash(
      this.rootNode.getHash() + this.indexNotes.map((n) => n.getHash()).join()
    );
  }
}

export class IndexUpdater {
  app: App;
  settings: IndexNotesSettings;
  previousHash: string = "";
  updateTimeout: NodeJS.Timeout | null = null;
  updateInProgress: boolean = false;
  pendingTagUpdates: Set<string> = new Set(); // Track tags pending update
  fileTagHistory: Map<string, Set<string>> = new Map(); // Track previous tags for files

  constructor(app: App, settings: IndexNotesSettings) {
    this.app = app;
    this.settings = settings;
  }

  async scan(): Promise<IndexSchema> {
    const excludedFolders = this.settings.exclude_folders.filter(
      (f) => f.length > 0
    );
    const mdFiles = this.app.vault
      .getMarkdownFiles()
      .filter((f) => !excludedFolders.some((excl) => f.path.startsWith(excl)));
    const indexSchema = new IndexSchema();
    const rootNode = new Node("", this.settings, this.app);
    const regexIndexTagComponents = new RegExp(
      `(?:^|(?:\/))(?:${this.settings.index_tag})|(?:${this.settings.meta_index_tag})$`
    );
    const regexContainsIndex = /\^indexof-(?:[a-zA-Z0-9]+-?)+/g;
    const regexContainsMarkers = new RegExp(
      `${INDEX_START_MARKER}|${META_INDEX_START_MARKER}`
    );

    // Track all promises to ensure they complete
    const fileReadPromises: Promise<void>[] = [];

    // Process all files
    mdFiles.forEach((note) => {
      try {
        const frontmatter = this.app.metadataCache.getCache(
          note.path
        )?.frontmatter;
        const indexNote = new IndexNote(note, this.app, this.settings);

        // Process frontmatter tags
        if (frontmatter) {
          // Get tags from frontmatter or from the cache
          let fileTags: string[] = [];

          if (frontmatter.tags) {
            // Handle different tag formats
            if (typeof frontmatter.tags === "string") {
              // String format - split by comma
              fileTags = frontmatter.tags.split(",").map((tag) => tag.trim());
            } else if (Array.isArray(frontmatter.tags)) {
              // Array format - use directly
              fileTags = frontmatter.tags.map((tag) =>
                typeof tag === "string" ? tag : String(tag)
              );
            } else {
              // Unknown format - log but don't error
              console.log(
                "Unusual tag format in note:",
                note.path,
                "Tags:",
                frontmatter.tags
              );
              fileTags = [];
            }
          }

          // Get any inline tags from the cache
          const cachedTags = this.app.metadataCache.getCache(note.path)?.tags;
          if (cachedTags && Array.isArray(cachedTags)) {
            cachedTags.forEach((tagObj) => {
              if (tagObj.tag) {
                // Remove the # from the beginning if present
                const tag = tagObj.tag.startsWith("#")
                  ? tagObj.tag.substring(1)
                  : tagObj.tag;
                fileTags.push(tag);
              }
            });
          }

          // Process the collected tags
          if (fileTags.length > 0) {
            const hasPriorityTag = fileTags.includes(
              this.settings.priority_tag
            );

            fileTags.forEach((tag) => {
              try {
                const canonicalTag = canonicalizeTag(tag);
                const cleanTagPath = canonicalizeTag(
                  canonicalTag.replace(regexIndexTagComponents, "")
                );
                if (
                  getLastTagComponent(canonicalTag) === this.settings.index_tag
                ) {
                  indexNote.indexTags.push(cleanTagPath);
                  rootNode.addNoteWithPath(
                    cleanTagPath,
                    note,
                    hasPriorityTag,
                    true
                  );
                } else if (
                  getLastTagComponent(canonicalTag) ===
                  this.settings.meta_index_tag
                ) {
                  indexNote.metaIndexTags.push(cleanTagPath);
                  rootNode.addNoteWithPath(
                    cleanTagPath,
                    note,
                    hasPriorityTag,
                    true
                  );
                } else {
                  rootNode.addNoteWithPath(
                    cleanTagPath,
                    note,
                    hasPriorityTag,
                    false
                  );
                }
              } catch (error) {
                console.error(
                  "Error processing tag:",
                  tag,
                  "in note:",
                  note.path,
                  error
                );
              }
            });
          }
        }

        // Add index notes with tags immediately
        if (indexNote.indexTags.length || indexNote.metaIndexTags.length) {
          indexSchema.indexNotes.push(indexNote);
        } else {
          // For notes without index tags, check file content for stale index blocks or markers
          const promise = this.app.vault
            .read(note)
            .then((content) => {
              if (
                content.match(regexContainsIndex) ||
                content.match(regexContainsMarkers)
              ) {
                indexSchema.indexNotes.push(indexNote);
              }
            })
            .catch((error) => {
              console.error("Error reading file:", note.path, error);
            });

          fileReadPromises.push(promise);
        }
      } catch (error) {
        console.error("Error processing note:", note.path, error);
      }
    });

    // Wait for all file reads to complete
    await Promise.all(fileReadPromises);

    rootNode.sortAll();
    indexSchema.rootNode = rootNode;
    return indexSchema;
  }

  /**
   * Determines if a note should be updated based on relevant tags
   * @param note The index note to check
   * @param relevantTags Tags that were modified and need updates
   * @returns True if the note should be updated
   */
  shouldUpdateNote(note: IndexNote, relevantTags: Set<string>): boolean {
    // If no specific tags are specified, update all
    if (relevantTags.size === 0) {
      return true;
    }

    // Check if any of the note's index tags intersect with relevant tags
    for (const tag of note.indexTags) {
      // Check if this tag or any parent tag is in the relevant tags set
      let checkTag = tag;
      while (checkTag) {
        if (relevantTags.has(checkTag)) {
          return true;
        } else {
          break;
        }
      }
    }

    // Similarly check meta-index tags
    for (const tag of note.metaIndexTags) {
      let checkTag = tag;
      while (checkTag) {
        if (relevantTags.has(checkTag)) {
          return true;
        }
        const lastSlashIndex = checkTag.lastIndexOf('/');
        if (lastSlashIndex >= 0) {
          checkTag = checkTag.substring(0, lastSlashIndex);
        } else {
          break;
        }
      }
    }

    return false;
  }

  /**
   * Gets the set of all tags affected by a change in a specific file,
   * including tags that were removed since the last modification
   * @param file The file that was changed
   * @returns Set of tags that need to be updated
   */
  async getRelevantTagsForFile(file: TFile | null): Promise<Set<string>> {
    const tags = new Set<string>();
    
    if (!file) return tags;
    
    // Get file metadata and frontmatter tags
    const metadata = this.app.metadataCache.getCache(file.path);
    if (!metadata) return tags;
    
    // Get current tags from frontmatter and inline tags
    const currentTags = new Set<string>();
    
    // Process frontmatter tags
    if (metadata.frontmatter?.tags) {
      let fileTags: string[] = [];
      
      if (typeof metadata.frontmatter.tags === "string") {
        fileTags = metadata.frontmatter.tags.split(",").map(tag => tag.trim());
      } else if (Array.isArray(metadata.frontmatter.tags)) {
        fileTags = metadata.frontmatter.tags.map(tag => 
          typeof tag === "string" ? tag : String(tag)
        );
      }
      
      // Process each tag to get the exact tag path only
      fileTags.forEach(tag => {
        const canonicalTag = canonicalizeTag(tag);
        // Remove index_tag or meta_index_tag from the end
        const regexIndexTagComponents = new RegExp(
          `(?:^|(?:\/))(?:${this.settings.index_tag})|(?:${this.settings.meta_index_tag})$`
        );
        const cleanTagPath = canonicalizeTag(
          canonicalTag.replace(regexIndexTagComponents, "")
        );
        
        // Add to current tags and relevant tags
        currentTags.add(cleanTagPath);
        tags.add(cleanTagPath);
      });
    }
    
    // Process inline tags
    if (metadata.tags) {
      metadata.tags.forEach(tagObj => {
        if (tagObj.tag) {
          const tag = tagObj.tag.startsWith("#") 
            ? tagObj.tag.substring(1) 
            : tagObj.tag;
          
          const canonicalTag = canonicalizeTag(tag);
          const regexIndexTagComponents = new RegExp(
            `(?:^|(?:\/))(?:${this.settings.index_tag})|(?:${this.settings.meta_index_tag})$`
          );
          const cleanTagPath = canonicalizeTag(
            canonicalTag.replace(regexIndexTagComponents, "")
          );
          
          // Add to current tags and relevant tags
          currentTags.add(cleanTagPath);
          tags.add(cleanTagPath);
        }
      });
    }
    
    // Check for removed tags by comparing with the history
    if (this.fileTagHistory.has(file.path)) {
      const previousTags = this.fileTagHistory.get(file.path)!;
      
      // Add any tags that were present before but aren't now
      previousTags.forEach(tag => {
        if (!currentTags.has(tag)) {
          console.log(`Tag was removed from file: ${tag}`);
          tags.add(tag); // This tag was deleted, so include it for updates
        }
      });
    }
    
    // Update the history with current tags
    this.fileTagHistory.set(file.path, currentTags);
    
    return tags;
  }

  async updateAsync(relevantTags: Set<string> = new Set()): Promise<void> {
    try {
      const t0 = Date.now();
      // Check if there's an active file in the editor
      const activeFile = this.app.workspace.getActiveFile();

      // Start the scan process, but don't block waiting for it
      this.scan().then(async (indexSchema) => {
        if (activeFile && !this.settings.enable_auto_update) {
          // Only process the active file if it's in the index notes
          const activeIndexNote = indexSchema.indexNotes.find(
            (note) => note.note.path === activeFile.path
          );

          if (activeIndexNote) {
            try {
              console.log("Updating active file:", activeFile.path);
              const indexBlocks = activeIndexNote.createIndexBlocks(
                indexSchema.rootNode
              );

              const content = await this.app.vault.read(activeFile);
              const updatedContent = activeIndexNote.getUpdatedContent(
                content,
                indexBlocks
              );

              if (content !== updatedContent) {
                await this.app.vault.modify(activeFile, updatedContent);
                console.log(
                  "Updated active file " +
                    activeFile.path +
                    " in " +
                    (Date.now() - t0) +
                    " ms"
                );
              } else {
                console.log("No changes needed for " + activeFile.path);
              }
            } catch (error) {
              console.error("Error updating active file:", error);
            }
            return;
          }
        }

        // Filter index notes to only those that need updating based on the relevant tags
        const notesToUpdate = indexSchema.indexNotes.filter(note => 
          this.shouldUpdateNote(note, relevantTags)
        );
        
        console.log(`Updating ${notesToUpdate.length} of ${indexSchema.indexNotes.length} index notes based on relevant tags`, {relevantTags}, "for ", activeFile?.path);
        
        // Process only the filtered notes
        await this.processIndexNotesInBatches(
          notesToUpdate,
          indexSchema.rootNode
        );
      });

      // Don't wait for the promise to resolve - return immediately
      return Promise.resolve();
    } catch (error) {
      console.error("Error in updateAsync:", error);
      return Promise.resolve(); // Still resolve the promise to maintain non-blocking behavior
    }
  }

  /**
   * Process index notes in small batches to avoid blocking the UI thread
   */
  async processIndexNotesInBatches(
    indexNotes: IndexNote[],
    rootNode: Node,
    batchSize: number = 5
  ): Promise<void> {
    // Clone the array to avoid modifying the original
    const notesToProcess = [...indexNotes];

    // Process notes in batches
    while (notesToProcess.length > 0) {
      // Take a batch of notes
      const batch = notesToProcess.splice(0, batchSize);

      // Process this batch
      for (const indexNote of batch) {
        try {
          const indexBlocks = indexNote.createIndexBlocks(rootNode);
          const content = await this.app.vault.read(indexNote.note);
          const updatedContent = indexNote.getUpdatedContent(
            content,
            indexBlocks
          );

          // Only modify if there are actual changes
          if (content !== updatedContent) {
            await this.app.vault.modify(indexNote.note, updatedContent);
          }
        } catch (error) {
          console.error("Error updating note:", indexNote.note.path, error);
        }
      }

      // If there are more notes to process, wait a short time to let UI update
      if (notesToProcess.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  update(changedFile: TFile | null = null): void {
    // Clear any existing timeout to implement debouncing
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    
    // If a specific file changed, add its tags to the pending updates
    if (changedFile) {
      this.getRelevantTagsForFile(changedFile).then(tags => {
        // Add all relevant tags to the pending set
        tags.forEach(tag => this.pendingTagUpdates.add(tag));
      });
    }

    // Queue the update with a small delay to allow UI operations to complete first
    this.updateTimeout = setTimeout(() => {
      // Only start a new update if there's no update in progress
      if (!this.updateInProgress) {
        this.updateInProgress = true;
        
        // Create a copy of the pending tags and clear the pending set
        const tagsToUpdate = new Set(this.pendingTagUpdates);
        this.pendingTagUpdates.clear();

        // Run the update asynchronously with the collected tags
        this.updateAsync(tagsToUpdate)
          .catch((error) => {
            console.error("Unhandled error in update:", error);
          })
          .finally(() => {
            // Mark as completed when done
            this.updateInProgress = false;
            this.updateTimeout = null;
          });
      }
    }, 100); // Small delay for UI responsiveness
  }
}
