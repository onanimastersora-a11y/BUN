import fs from 'node:fs';

// JSON file storage for the backend. Writes are debounced and atomic
// (write to .tmp, then rename) so a crash never leaves a half-written file.
export function fileStorage(file) {
  let timer = null;
  let pending = null;

  const flush = () => {
    clearTimeout(timer);
    if (!pending) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pending));
    fs.renameSync(tmp, file);
    pending = null;
  };

  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };

  return {
    load() {
      const data = read(file) || read(`${file}.bak`);
      // Keep one known-good copy from the previous launch.
      if (data) fs.writeFileSync(`${file}.bak`, JSON.stringify(data));
      return data;
    },
    save(db) {
      pending = db;
      clearTimeout(timer);
      timer = setTimeout(flush, 120);
    },
    flush,
  };
}

// Tiny key/value file for machine-level state (pet window position etc.).
export function jsonFile(file, defaults) {
  let data = { ...defaults };
  try {
    data = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {}
  const write = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(data));
    } catch {}
  };
  return {
    get: (k) => data[k],
    // The whole file as one value (used by the cloud sync state).
    asStore: () => ({
      load: () => data,
      save(v) {
        data = v;
        write();
      },
    }),
    set(k, v) {
      data[k] = v;
      try {
        fs.writeFileSync(file, JSON.stringify(data));
      } catch {}
    },
  };
}
