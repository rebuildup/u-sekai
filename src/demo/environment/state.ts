/**
 * Demo environment state. In-memory only; one process per server run.
 *
 * The state is intentionally minimal: there is no auth, no validation,
 * and one path is a deliberate dead end (the "Settings" page links
 * nowhere useful) so that participants can be observed navigating
 * confusion honestly.
 */

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly done: boolean;
}

export interface DemoState {
  readonly tasks: Map<string, Task>;
  readonly settings: { theme: 'light' | 'dark'; notifications: boolean };
}

export function createDemoState(): DemoState {
  const tasks = new Map<string, Task>();
  return {
    tasks,
    settings: { theme: 'light', notifications: false },
  };
}

export function nextTaskId(state: DemoState): string {
  return `${state.tasks.size + 1}`;
}
