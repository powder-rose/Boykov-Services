export const DOCS_CUSTOMERS_SINCE: string;
export type CompanyField =
  | "companyName"
  | "inn"
  | "headPosition"
  | "headFullName"
  | "occupationalSafetyPosition"
  | "occupationalSafetyFullName";
export const DOCS_COMPANY_FIELDS: {
  name: CompanyField;
  label: string;
  max: number;
}[];
export const DOCS_CALL_OUTCOMES: Record<
  "reached" | "no_answer" | "callback",
  string
>;
