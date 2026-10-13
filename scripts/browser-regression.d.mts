export function browserRegression(
  page: any,
  highlightText: (page: any, selector: string, phrase: string) => Promise<void>,
): Promise<{ passed: string[] }>;
