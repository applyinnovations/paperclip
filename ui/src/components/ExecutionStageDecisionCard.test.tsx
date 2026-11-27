// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Issue, IssueExecutionState } from "@paperclipai/shared";
import {
  ExecutionStageDecisionCard,
  canActOnPendingExecutionStage,
  type ExecutionStageDecisionCardProps,
} from "./ExecutionStageDecisionCard";
import { issuesApi } from "../api/issues";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const pushToastMock = vi.fn();

vi.mock("../api/issues", () => ({
  issuesApi: {
    update: vi.fn(),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: pushToastMock,
  }),
}));

function makeExecutionState(
  overrides: Partial<IssueExecutionState> = {},
): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "approval",
    currentParticipant: {
      type: "user",
      agentId: null,
      userId: "user-1",
    },
    returnAssignee: {
      type: "agent",
      agentId: "agent-1",
      userId: null,
    },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

function makeIssue(
  executionState: IssueExecutionState | null = makeExecutionState(),
): Pick<Issue, "id" | "companyId" | "executionState"> {
  return {
    id: "issue-1",
    companyId: "company-1",
    executionState,
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("canActOnPendingExecutionStage", () => {
  it("returns true for pending approval and review stages assigned to currentUserId", () => {
    expect(
      canActOnPendingExecutionStage(
        makeIssue(makeExecutionState({ currentStageType: "approval" })),
        "user-1",
      ),
    ).toBe(true);
    expect(
      canActOnPendingExecutionStage(
        makeIssue(makeExecutionState({ currentStageType: "review" })),
        "user-1",
      ),
    ).toBe(true);
  });

  it("returns false when participant is an agent, another user, or stage is not pending", () => {
    expect(
      canActOnPendingExecutionStage(
        makeIssue(
          makeExecutionState({
            currentParticipant: {
              type: "agent",
              agentId: "agent-2",
              userId: null,
            },
          }),
        ),
        "user-1",
      ),
    ).toBe(false);

    expect(
      canActOnPendingExecutionStage(
        makeIssue(
          makeExecutionState({
            currentParticipant: {
              type: "user",
              agentId: null,
              userId: "user-2",
            },
          }),
        ),
        "user-1",
      ),
    ).toBe(false);

    expect(
      canActOnPendingExecutionStage(
        makeIssue(makeExecutionState({ status: "changes_requested" })),
        "user-1",
      ),
    ).toBe(false);

    expect(
      canActOnPendingExecutionStage(
        makeIssue(makeExecutionState({ status: "completed" })),
        "user-1",
      ),
    ).toBe(false);

    expect(canActOnPendingExecutionStage(makeIssue(null), "user-1")).toBe(false);
    expect(canActOnPendingExecutionStage(makeIssue(), null)).toBe(false);
  });
});

describe("ExecutionStageDecisionCard", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });

  async function renderCard(props: Partial<ExecutionStageDecisionCardProps> = {}) {
    const agentMap = new Map<string, Pick<Agent, "id" | "name">>([
      ["agent-1", { id: "agent-1", name: "Builder Bot" }],
    ]);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ExecutionStageDecisionCard
            issue={makeIssue()}
            currentUserId="user-1"
            agentMap={agentMap}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
  }

  it("renders Approve and Request changes for a pending approval stage matching currentUserId", async () => {
    await renderCard();

    expect(
      container.querySelector('[data-testid="execution-stage-decision-card"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Approval required");
    expect(container.textContent).toContain("Builder Bot");
    expect(
      container.querySelector('[data-testid="execution-stage-approve"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="execution-stage-request-changes"]'),
    ).not.toBeNull();
  });

  it("renders Review required copy for a pending review stage", async () => {
    await renderCard({
      issue: makeIssue(makeExecutionState({ currentStageType: "review" })),
    });

    expect(container.textContent).toContain("Review required");
    expect(
      container.querySelector('[data-testid="execution-stage-approve"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="execution-stage-request-changes"]'),
    ).not.toBeNull();
  });

  it("does not render when currentParticipant is an agent, another user, or status is not pending", async () => {
    await renderCard({
      issue: makeIssue(
        makeExecutionState({
          currentParticipant: {
            type: "agent",
            agentId: "agent-2",
            userId: null,
          },
        }),
      ),
    });
    expect(container.textContent).toBe("");

    await renderCard({
      issue: makeIssue(
        makeExecutionState({
          currentParticipant: {
            type: "user",
            agentId: null,
            userId: "user-other",
          },
        }),
      ),
    });
    expect(container.textContent).toBe("");

    await renderCard({
      issue: makeIssue(makeExecutionState({ status: "completed" })),
    });
    expect(container.textContent).toBe("");
  });

  it("sends default approval comment when approving an approval stage with an empty note", async () => {
    vi.mocked(issuesApi.update).mockResolvedValueOnce({} as never);
    const onResolved = vi.fn();
    await renderCard({ onResolved });

    const approveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="execution-stage-approve"]',
    )!;
    await act(async () => {
      approveButton.click();
    });

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", {
      status: "done",
      comment: "Approved.",
    });
    expect(onResolved).toHaveBeenCalledWith("approve");
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    );
  });

  it("sends default review approval comment when approving a review stage with an empty note", async () => {
    vi.mocked(issuesApi.update).mockResolvedValueOnce({} as never);
    await renderCard({
      issue: makeIssue(makeExecutionState({ currentStageType: "review" })),
    });

    const approveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="execution-stage-approve"]',
    )!;
    await act(async () => {
      approveButton.click();
    });

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", {
      status: "done",
      comment: "Review approved.",
    });
  });

  it("sends custom note when approving with a non-empty note", async () => {
    vi.mocked(issuesApi.update).mockResolvedValueOnce({} as never);
    await renderCard();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="execution-stage-decision-note"]',
    )!;
    await act(async () => {
      setTextareaValue(textarea, "  Looks great, ship it!  ");
    });

    const approveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="execution-stage-approve"]',
    )!;
    await act(async () => {
      approveButton.click();
    });

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", {
      status: "done",
      comment: "Looks great, ship it!",
    });
  });

  it("disables Request changes when note is empty and submits in_progress with note when filled", async () => {
    vi.mocked(issuesApi.update).mockResolvedValueOnce({} as never);
    const onResolved = vi.fn();
    await renderCard({ onResolved });

    const requestChangesButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="execution-stage-request-changes"]',
    )!;
    expect(requestChangesButton.disabled).toBe(true);

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="execution-stage-decision-note"]',
    )!;
    await act(async () => {
      setTextareaValue(textarea, "Please add error handling.");
    });

    expect(requestChangesButton.disabled).toBe(false);

    await act(async () => {
      requestChangesButton.click();
    });

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", {
      status: "in_progress",
      comment: "Please add error handling.",
    });
    expect(onResolved).toHaveBeenCalledWith("request_changes");
  });

  it("hides Request changes when returnAssignee is null", async () => {
    await renderCard({
      issue: makeIssue(makeExecutionState({ returnAssignee: null })),
    });

    expect(
      container.querySelector('[data-testid="execution-stage-request-changes"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="execution-stage-approve"]'),
    ).not.toBeNull();
  });

  it("displays an inline error alert and error toast when the mutation rejects", async () => {
    vi.mocked(issuesApi.update).mockRejectedValueOnce(
      new Error("Only the active reviewer can advance the stage."),
    );
    await renderCard();

    const approveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="execution-stage-approve"]',
    )!;
    await act(async () => {
      approveButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "Only the active reviewer can advance the stage.",
    );
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: "error",
        body: "Only the active reviewer can advance the stage.",
      }),
    );
  });
});
