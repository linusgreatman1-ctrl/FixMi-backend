// Super-admin "Code Editor" and "Codes" tools: live-patch the static frontend
// files (the app and the admin page) without a full git push and redeploy.
// Code Editor is a targeted find and replace; Codes is full raw-file load and
// save. Every write is preceded by a timestamped backup and followed by a
// syntax check of the file's inline <script>; a failed check aborts the write
// and nothing on disk changes, so a bad edit cannot take the live app down.
//
// Note: on Railway the container is rebuilt from git on each deploy, so edits
// made here stay live until the next deploy. Put anything you want to keep in git.
const fs = require("fs");
const path = require("path");
const { logAdminAction } = require("../services/auditLog.service");

const ROOT = path.join(__dirname, "..", "..");
// Backups go on the persistent volume when there is one.
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || (fs.existsSync("/data") ? "/data/backups" : path.join(ROOT, "backups")));

// Whitelist only: "file" from the request is looked up here and never used to
// build a path, so there is no path-traversal surface.
const EDITABLE_FILES = {
  "app/index.html": path.join(ROOT, "public", "app", "index.html"),
  "admin/index.html": path.join(ROOT, "public", "admin", "index.html"),
  "app-dev/index.html": path.join(ROOT, "public", "app-dev", "index.html"),
  "admin-dev/index.html": path.join(ROOT, "public", "admin-dev", "index.html"),
};

// The -dev copies let a change be previewed before the live file is touched.
function ensureDevCopies() {
  for (const [dev, live] of [["app-dev/index.html", "app/index.html"], ["admin-dev/index.html", "admin/index.html"]]) {
    try {
      if (!fs.existsSync(EDITABLE_FILES[dev])) {
        fs.mkdirSync(path.dirname(EDITABLE_FILES[dev]), { recursive: true });
        fs.copyFileSync(EDITABLE_FILES[live], EDITABLE_FILES[dev]);
      }
    } catch (err) {
      console.error("[files] could not create", dev, err.message);
    }
  }
}

function resolveFile(key) {
  return EDITABLE_FILES[key] || null;
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function writeBackup(key, content) {
  ensureBackupDir();
  const name = `${key.replace(/\//g, "_")}.${Date.now()}.bak`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), content, "utf8");
  return name;
}

// Throws SyntaxError on bad JS; the code is compiled but never executed.
function checkScriptSyntax(content) {
  for (const m of content.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    new Function(m[1]);
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

async function listFiles(req, res, next) {
  try {
    ensureDevCopies();
    const files = Object.entries(EDITABLE_FILES).map(([key, abs]) => {
      const stat = fs.statSync(abs);
      return { file: key, sizeBytes: stat.size, modifiedAt: stat.mtime };
    });
    res.json({ files });
  } catch (err) {
    next(err);
  }
}

async function searchInFile(req, res, next) {
  try {
    const { file, query, contextChars } = req.body;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    if (!query) return res.status(400).json({ error: "query is required." });
    const ctx = Math.min(300, Math.max(0, parseInt(contextChars, 10) || 60));

    const content = fs.readFileSync(abs, "utf8");
    const matches = [];
    let idx = 0;
    while (matches.length < 30) {
      idx = content.indexOf(query, idx);
      if (idx === -1) break;
      matches.push({
        occurrenceIndex: matches.length,
        before: content.slice(Math.max(0, idx - ctx), idx),
        match: query,
        after: content.slice(idx + query.length, idx + query.length + ctx),
        charOffset: idx,
      });
      idx += query.length;
    }
    const totalOccurrences = countOccurrences(content, query);
    res.json({ matches, totalOccurrences, truncated: totalOccurrences > matches.length });
  } catch (err) {
    next(err);
  }
}

async function replaceInFile(req, res, next) {
  try {
    const { file, find, replaceWith, occurrenceIndex, replaceAll } = req.body;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    if (!find) return res.status(400).json({ error: "find is required." });
    if (replaceWith === undefined || replaceWith === null) return res.status(400).json({ error: "replaceWith is required." });

    const content = fs.readFileSync(abs, "utf8");
    const total = countOccurrences(content, find);
    if (total === 0) return res.status(404).json({ error: "No occurrences of that text found." });

    let newContent;
    if (replaceAll) {
      newContent = content.split(find).join(replaceWith);
    } else if (occurrenceIndex !== undefined && occurrenceIndex !== null) {
      const n = parseInt(occurrenceIndex, 10);
      if (n < 0 || n >= total) return res.status(400).json({ error: `occurrenceIndex out of range (0-${total - 1}).` });
      let idx = -1;
      for (let i = 0; i <= n; i++) idx = content.indexOf(find, idx + 1);
      newContent = content.slice(0, idx) + replaceWith + content.slice(idx + find.length);
    } else if (total === 1) {
      const idx = content.indexOf(find);
      newContent = content.slice(0, idx) + replaceWith + content.slice(idx + find.length);
    } else {
      return res.status(409).json({ error: "Text is not unique in this file.", occurrences: total });
    }

    try {
      checkScriptSyntax(newContent);
    } catch (syntaxErr) {
      return res.status(400).json({ error: "Replacement would break the page's script syntax: " + syntaxErr.message });
    }

    const backupName = writeBackup(file, content);
    fs.writeFileSync(abs, newContent, "utf8");
    await logAdminAction(req.user, "CODE_EDITOR_REPLACE", "FILE", file, `Replaced ${replaceAll ? total : 1} occurrence(s) of "${String(find).slice(0, 60)}" (backup: ${backupName})`);
    res.json({ success: true, replacedCount: replaceAll ? total : 1, backupName });
  } catch (err) {
    next(err);
  }
}

async function listBackups(req, res, next) {
  try {
    ensureBackupDir();
    const { file } = req.query;
    const prefix = file ? String(file).replace(/\//g, "_") + "." : "";
    const names = fs.readdirSync(BACKUP_DIR).filter((n) => n.endsWith(".bak") && (!file || n.startsWith(prefix)));
    const backups = names
      .map((name) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, name));
        return { name, sizeBytes: stat.size, createdAt: stat.mtime };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ backups });
  } catch (err) {
    next(err);
  }
}

async function restoreBackup(req, res, next) {
  try {
    const { file, backupName } = req.body;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    if (!backupName || typeof backupName !== "string") return res.status(400).json({ error: "backupName is required." });

    const backupPath = path.join(BACKUP_DIR, backupName);
    // The resolved path must sit directly inside BACKUP_DIR and belong to this file.
    if (path.dirname(backupPath) !== BACKUP_DIR || !backupName.startsWith(file.replace(/\//g, "_") + ".")) {
      return res.status(400).json({ error: "Invalid backup." });
    }
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: "Backup not found." });

    const backupContent = fs.readFileSync(backupPath, "utf8");
    try {
      checkScriptSyntax(backupContent);
    } catch (syntaxErr) {
      return res.status(400).json({ error: "That backup fails a syntax check, so it will not be restored: " + syntaxErr.message });
    }

    const current = fs.readFileSync(abs, "utf8");
    const safetyBackupName = writeBackup(file, current); // restoring is itself undoable
    fs.writeFileSync(abs, backupContent, "utf8");
    await logAdminAction(req.user, "CODE_EDITOR_RESTORE", "FILE", file, `Restored from ${backupName} (safety backup: ${safetyBackupName})`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function getContent(req, res, next) {
  try {
    const abs = resolveFile(req.query.file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    res.type("text/plain").send(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    next(err);
  }
}

async function saveContent(req, res, next) {
  try {
    const { file, confirmDrasticShrink } = req.query;
    const abs = resolveFile(file);
    if (!abs) return res.status(400).json({ error: "Unknown file." });
    const newContent = req.body;
    if (typeof newContent !== "string" || !newContent.length) {
      return res.status(400).json({ error: "Request body must be the full file content as text." });
    }

    const current = fs.readFileSync(abs, "utf8");
    if (newContent.length < current.length * 0.5 && confirmDrasticShrink !== "true") {
      return res.status(409).json({
        error: "The new content is less than half the current file's size. This usually means the editor lost its contents.",
        currentSizeBytes: current.length,
        newSizeBytes: newContent.length,
      });
    }

    try {
      checkScriptSyntax(newContent);
    } catch (syntaxErr) {
      return res.status(400).json({ error: "The new content fails a script syntax check: " + syntaxErr.message });
    }

    const backupName = writeBackup(file, current);
    fs.writeFileSync(abs, newContent, "utf8");
    await logAdminAction(req.user, "CODE_EDITOR_SAVE", "FILE", file, `Full-file save (backup: ${backupName})`);
    res.json({ success: true, backupName });
  } catch (err) {
    next(err);
  }
}

module.exports = { ensureDevCopies, listFiles, searchInFile, replaceInFile, listBackups, restoreBackup, getContent, saveContent };
