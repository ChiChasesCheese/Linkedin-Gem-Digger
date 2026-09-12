// Pure data. Adding a rule = adding one entry here.
export const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';

/** Sentences containing these are never YOE requirements. */
export const YOE_NOISE = /\b(benefits?|vacation|pto|founded|history|ago|track record|years? old|warranty|anniversary)\b/i;

/** Sentences phrasing YOE as a cap ("no more than", "up to") are not a minimum requirement. */
export const YOE_CAP = /\b(?:no more than|not more than|up to|less than|fewer than|maximum of)\b/i;

/**
 * Company-history / tenure phrasing ("For 25 years, ENFOS has helped...", "Celebrating 30
 * years in business", "The team has shipped for 12 years") is never a YOE requirement.
 */
export const YOE_COMPANY_RE =
  /\b(?:for|over|nearly|almost|celebrating|with)\s+(?:the\s+(?:past|last)\s+)?(?:more than\s+|over\s+)?\d{1,3}\+?\s+years,?\s+(?:we|our|us|it|[A-Za-z][\w&.'-]*)\s+(?:has|have|had|is|are|been|'ve|'s)\b|\byears?\s+in\s+business\b|(?<!experience\s)\byears?\s+of\s+(?:operation|service|success|growth|innovation|leadership in)\b|\b(?:has|have|had)\s+[a-z]+(?:ed|en)\s+for\s+\d{1,3}\+?\s+years\b/i;

/** YOE context required AFTER a matched "N years" span (within 50 chars) to count as a requirement. */
export const YOE_AFTER_CTX =
  /\b(?:of|in|with|as|building|developing|designing|working|writing|programming|coding|using|on|experience|exp\.?|professional|hands-on|industry|relevant|background|shipping|leading|managing)\b/i;

/** YOE context required BEFORE a matched "N years" span (within 50 chars) to count as a requirement. */
export const YOE_BEFORE_CTX =
  /\b(?:experience|exp\.?|minimum|min\.?|at least|require[sd]?|must have|must possess|ideally|preferably|looking for|have|has|possess|bring|over|more than|with)\b/i;

/** A softener in the same sentence downgrades red → yellow. */
export const SOFTENERS = /\b(preferred|nice to have|a plus|bonus|ideally|plus but not required)\b/i;

/** Sentences must mention one of these alongside a $ amount to count as a stated salary. */
export const PAY_KEYWORD_RE = /\b(salary|salaries|compensation|base pay|pay range|pay rate|per hour|hourly|per year|annually|annual|\/yr|\/hr|\/hour|a year|an hour)\b/i;

/** Matches "88 applicants" / "1,234 applicants" / "Over 100 people clicked apply"; group 1 is the applicant count (comma-grouped digits allowed). */
export const APPLICANTS_RE = /\b(?:over\s+)?(\d{1,3}(?:,\d{3})+|\d{1,5})\+?\s+(?:applicants|people\s+clicked\s+apply)\b/i;

/** Titles that must never be greyed by the seniority greylist. */
export const TITLE_EXEMPT = /\b(intern(ship)?|new grad(uate)?|entry[- ]level|junior|early[- ]career|university grad(uate)?)\b/i;

/**
 * Rule = { id, category, severity, scope, pattern, extract?, defaultOn }
 * pattern must carry the g flag; analyze() clones it per use.
 */
export const TEXT_RULES = [
  {
    id: 'yoe', category: 'experience', severity: 'red', scope: 'text', defaultOn: true,
    pattern: new RegExp(`\\b${NUM}\\s*(?:\\+|(?:-|–|to)\\s*\\d{1,2})?\\s*\\+?\\s*(?:years?|yrs?)\\b`, 'gi'),
    extract: (m) => {
      const raw = m[1].toLowerCase();
      return NUMBER_WORDS[raw] ?? parseInt(raw, 10);
    },
  },
  {
    id: 'citizenship', category: 'citizenship', severity: 'red', scope: 'text', defaultOn: true,
    pattern: /\b(?:u\.?s\.?\s+citizen(?:s|ship)?\s+(?:is\s+)?(?:required|only|mandatory)|must\s+be\s+(?:a\s+)?u\.?s\.?\s+citizens?|u\.?s\.?\s+persons?\s+only|citizenship\s+(?:is\s+)?required)\b/gi,
  },
  {
    id: 'clearance', category: 'clearance', severity: 'red', scope: 'text', defaultOn: true,
    pattern: /\b(?:security\s+clearance|(?:top\s+secret|secret|ts\/sci|public\s+trust)(?:\s+security)?\s+clearance|\bitar\b|export[- ]control(?:led)?)\b/gi,
  },
  {
    id: 'sponsorship', category: 'sponsorship', severity: 'red', scope: 'text', defaultOn: true,
    pattern: /\b(?:no\s+(?:visa\s+)?sponsorship|(?:unable|not\s+able|will\s+not|cannot|can't|do(?:es)?\s+not)\s+(?:to\s+)?(?:provide\s+|offer\s+)?sponsor(?:ship)?|(?:no|not|cannot|unable to|will not|won't|do(?:es)? not)\s+(?:provide\s+|offer\s+)?(?:h-?1b|visa)\s+(?:sponsorship|transfer)|h-?1b\s+(?:sponsorship|transfers?)\s+(?:is\s+)?(?:not\s+available|unavailable)|(?:authorized|authorised|eligible)\s+to\s+work\s+(?:in\s+the\s+(?:u\.?s\.?a?|united\s+states)\s+)?without\s+(?:the\s+need\s+for\s+|requiring\s+)?(?:visa\s+)?sponsorship|(?:without|no)\s+(?:current\s+or\s+future\s+)?(?:need\s+for\s+)?(?:visa\s+)?sponsorship)\b/gi,
  },
  {
    id: 'degree', category: 'degree', severity: 'yellow', scope: 'text', defaultOn: false,
    pattern: /\b(?:ph\.?d\.?|master'?s|m\.?s\.?|doctorate)\s+(?:degree\s+)?(?:is\s+)?required\b/gi,
  },
  {
    id: 'reposted', category: 'freshness', severity: 'yellow', scope: 'text', defaultOn: true,
    pattern: /\breposted\s+\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b/gi,
  },
];
