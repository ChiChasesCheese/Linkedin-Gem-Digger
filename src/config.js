// Single source of truth for user-configurable behaviour.
export const DEFAULTS = Object.freeze({
  yoeThreshold: 2,
  salaryFloor: 130000,
  applicantsMax: 100,
  titleGreylist: ['Senior', 'Sr.', 'Staff', 'Principal', 'Lead', 'Manager', 'Director', 'Architect', 'Head of'],
  titleIgnorelist: ['Member of Technical Staff', 'Technical Staff', 'MTS'],
  dockSide: 'left',
  rules: {
    yoe: true, citizenship: true, clearance: true, sponsorship: true, degree: false,
    reposted: true, 'title-seniority': true, 'salary-max': true, viewed: true,
    promoted: false, 'easy-apply': true, applicants: true,
  },
  repostedIsRed: false,
  hideInsteadOfGrey: false,
  scan: { intervalMs: 1500, jitterMs: 500, cacheTtlDays: 7 },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = {};
  for (const k of Object.keys(base)) {
    const b = base[k];
    const o = over?.[k];
    const defaultValue = () => (Array.isArray(b) ? [...b] : b);
    if (isPlainObject(b)) {
      out[k] = deepMerge(b, isPlainObject(o) ? o : {});
    } else if (o === undefined || o === null) {
      out[k] = defaultValue();
    } else if (Array.isArray(o) === Array.isArray(b) && typeof o === typeof b) {
      out[k] = Array.isArray(o) ? [...o] : o;
    } else {
      out[k] = defaultValue();
    }
  }
  return out;
}

/** Overlay a stored (possibly partial / stale) config onto DEFAULTS. Never mutates DEFAULTS. */
export function mergeConfig(stored) {
  return deepMerge(DEFAULTS, isPlainObject(stored) ? stored : {});
}

const hasSync = () => typeof chrome !== 'undefined' && chrome.storage?.sync;

export async function loadConfig() {
  if (!hasSync()) return mergeConfig();
  const { config } = await chrome.storage.sync.get('config');
  return mergeConfig(config);
}

export async function saveConfig(config) {
  if (!hasSync()) return;
  await chrome.storage.sync.set({ config: mergeConfig(config) });
}
