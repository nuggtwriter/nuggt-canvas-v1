
export class InputStore {
  private static values: Record<string, string> = {};

  static setValue(id: string, value: string) {
    this.values[id] = value;
    // console.log(`[Store] Set ${id} = ${value}`);
  }

  static getValue(id: string): string | undefined {
    return this.values[id];
  }

  static getAll() {
    return this.values;
  }
}
