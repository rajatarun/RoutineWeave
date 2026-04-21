export type PromptVariables = Record<string, string | string[]>;

export class PromptRenderer {
  render(template: string, variables?: PromptVariables): string {
    if (!variables || Object.keys(variables).length === 0) return template;

    return template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_match, key: string) => {
      const trimmed = key.trim();
      if (trimmed in variables) {
        const val = variables[trimmed];
        return Array.isArray(val) ? JSON.stringify(val) : val;
      }
      return _match;
    });
  }

  injectDefaults(variables?: PromptVariables): PromptVariables {
    return {
      current_date: new Date().toISOString().split("T")[0],
      current_datetime: new Date().toISOString(),
      day_of_week: new Date().toLocaleDateString("en-US", { weekday: "long" }),
      ...variables,
    };
  }
}
