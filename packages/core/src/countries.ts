/** The countries a user can pick. Free text caused silent mismatches ("United State"), so only these are accepted. */
export const COUNTRIES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria",
  "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia",
  "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia",
  "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo (Brazzaville)",
  "Congo (Kinshasa)", "Costa Rica", "Cote d'Ivoire", "Croatia", "Cuba", "Cyprus", "Czechia", "Denmark", "Djibouti", "Dominica",
  "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia",
  "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea",
  "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq",
  "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait", "Kyrgyzstan",
  "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi",
  "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova",
  "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands",
  "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau",
  "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania",
  "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino",
  "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia",
  "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan",
  "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga",
  "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates",
  "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen",
  "Zambia", "Zimbabwe",
] as const;
export type Country = (typeof COUNTRIES)[number];

const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[.']/g, "").replace(/\s+/g, " ").trim().replace(/^the /, "");

const BY_NAME = new Map<string, Country>(COUNTRIES.map((c) => [norm(c), c]));
const ALIASES: Record<string, Country> = {
  usa: "United States", us: "United States", america: "United States", "united states of america": "United States",
  uk: "United Kingdom", england: "United Kingdom", scotland: "United Kingdom", "great britain": "United Kingdom", britain: "United Kingdom",
  holland: "Netherlands", uae: "United Arab Emirates", "ivory coast": "Cote d'Ivoire", czech: "Czechia", "czech republic": "Czechia",
  turkiye: "Turkey", "south korea": "South Korea", korea: "South Korea", swaziland: "Eswatini",
};

/** The listed spelling of a country, or undefined when it is not one we know. Case, accents and common aliases are tolerated. */
export function canonicalCountry(input: string): Country | undefined {
  const k = norm(input);
  return BY_NAME.get(k) ?? ALIASES[k];
}

/** Throws a message that names the value and, when it is close, the likely intended country. */
export function requireCountry(input: string): Country {
  const c = canonicalCountry(input);
  if (c) return c;
  const k = norm(input);
  const close = COUNTRIES.find((x) => norm(x).startsWith(k) || k.startsWith(norm(x).slice(0, Math.max(4, norm(x).length - 2))));
  throw new Error(`"${input}" is not in the country list${close ? `. Did you mean "${close}"?` : ""}`);
}
