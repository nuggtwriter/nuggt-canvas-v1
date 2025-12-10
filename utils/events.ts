
type EventCallback = (detail: any) => void;

class EventEmitter {
  private events: Record<string, EventCallback[]> = {};

  on(event: string, callback: EventCallback) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(callback);
  }

  off(event: string, callback: EventCallback) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(cb => cb !== callback);
  }

  emit(event: string, detail: any) {
    if (!this.events[event]) return;
    this.events[event].forEach(cb => cb(detail));
  }
}

export const eventBus = new EventEmitter();
