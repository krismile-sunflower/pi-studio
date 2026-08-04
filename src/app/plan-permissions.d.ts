declare module '@picode-plan-permissions' {
  export interface PlanStep {
    id: string;
    title: string;
    detail?: string;
    status: 'pending' | 'in_progress' | 'complete' | 'blocked';
  }

  export interface PlanSessionState {
    phase: 'build' | 'plan' | 'review' | 'executing' | 'complete';
    goal: string;
    steps: PlanStep[];
    updatedAt: string;
  }

  export function isSafePlanBash(command: unknown): boolean;
  export function isPlanToolAllowed(toolName: unknown, input: unknown): boolean;
  export function builtinPlanToolNames(tools: readonly unknown[]): string[];
  export function parsePlanResponse(text: string, existing: PlanSessionState): PlanStep[];
  export function applyPlanExecutionMarkers(
    state: PlanSessionState,
    completed: ReadonlySet<number>,
    blocked: ReadonlySet<number>,
  ): PlanSessionState;
}
