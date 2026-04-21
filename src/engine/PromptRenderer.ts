export class PromptRenderer {
  render(template: string, variables?: Record<string, string>): string {
    if (!variables || Object.keys(variables).length === 0) return template;

    return template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_match, key: string) => {
      const trimmed = key.trim();
      if (trimmed in variables) return variables[trimmed];
      return _match;
    });
  }

  injectDefaults(variables?: Record<string, string>): Record<string, string> {
    return {
      current_date: new Date().toISOString().split("T")[0],
      current_datetime: new Date().toISOString(),
      day_of_week: new Date().toLocaleDateString("en-US", { weekday: "long" }),
      ...variables,
    };
  }
}
