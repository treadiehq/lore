<script setup lang="ts">
import type { ActivityItem, ActivityQuery, ConnectorEvent } from "@lore-co/sdk";
import { computed, ref, watch } from "vue";
import { errorMessage } from "~/utils/memory";

definePageMeta({ middleware: "auth" });
useHead({ title: "Activity" });

type EventType = ConnectorEvent["type"];
type DisplayActivity = ActivityItem & {
  displayId: string;
  sourceActivities: readonly ActivityItem[];
};
const eventTypes: EventType[] = [
  "paired_turn",
  "observation",
  "context_delivery",
];
const PAGE_SIZE = 20;
const route = useRoute();
const router = useRouter();
const client = useSharedMemoryClient();
const filterError = ref("");

function routeValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function routeEventType(value: unknown): EventType | "" {
  return typeof value === "string" && eventTypes.includes(value as EventType)
    ? (value as EventType)
    : "";
}

function parseRouteDate(value: unknown, label: string): string | undefined {
  const raw = routeValue(value);
  if (raw === "") {
    return undefined;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} date is invalid.`);
  }
  return date.toISOString();
}

function localDateTime(value: unknown): string {
  const raw = routeValue(value);
  if (raw === "") {
    return "";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function draftIso(value: string, label: string): string | undefined {
  if (value.trim() === "") {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} date is invalid.`);
  }
  return date.toISOString();
}

const typeDraft = ref<EventType | "">(routeEventType(route.query.type));
const agentDraft = ref(routeValue(route.query.agent));
const connectorDraft = ref(routeValue(route.query.connector));
const fromDraft = ref(localDateTime(route.query.from));
const toDraft = ref(localDateTime(route.query.to));
const page = computed(() => {
  const parsed = Number(routeValue(route.query.page));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
});

watch(
  () => route.query,
  (query) => {
    typeDraft.value = routeEventType(query.type);
    agentDraft.value = routeValue(query.agent);
    connectorDraft.value = routeValue(query.connector);
    fromDraft.value = localDateTime(query.from);
    toDraft.value = localDateTime(query.to);
    try {
      const from = parseRouteDate(query.from, "From");
      const to = parseRouteDate(query.to, "To");
      filterError.value =
        from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)
          ? "To date must be at or after the from date."
          : "";
    } catch (caught) {
      filterError.value = errorMessage(caught);
    }
  },
  { immediate: true },
);

const listInput = computed<ActivityQuery>(() => {
  let from: string | undefined;
  let to: string | undefined;
  try {
    from = parseRouteDate(route.query.from, "From");
    to = parseRouteDate(route.query.to, "To");
  } catch {
    // The visible validation message handles malformed URL values.
  }
  const type = routeEventType(route.query.type);
  const agent = routeValue(route.query.agent).trim();
  const connector = routeValue(route.query.connector).trim();
  return {
    ...(type === "" ? {} : { type }),
    ...(agent === "" ? {} : { agent }),
    ...(connector === "" ? {} : { connector }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    limit: PAGE_SIZE,
    offset: (page.value - 1) * PAGE_SIZE,
  };
});

const {
  data: response,
  error,
  status,
  refresh,
} = await useAsyncData(
  "connector-activity",
  () => client.listActivity(listInput.value),
  { watch: [listInput] },
);

function displayActivity(activity: ActivityItem): DisplayActivity {
  return {
    ...activity,
    displayId: activity.event.id,
    sourceActivities: [activity],
  };
}

function interactionText(activity: ActivityItem): string {
  return activity.event.type === "context_delivery"
    ? contextDeliveryTask(activity)
    : activity.correction;
}

function interactionKey(activity: ActivityItem): string {
  return [
    activity.event.agent,
    activity.event.sessionId,
    normalizedContent(interactionText(activity)),
  ].join("\0");
}

function uniqueMemories(
  memories: ReadonlyArray<ActivityItem["learnedMemories"][number]>,
): ActivityItem["learnedMemories"] {
  return [
    ...new Map(memories.map((memory) => [memory.id, memory] as const)).values(),
  ];
}

function mergeInteraction(
  activities: readonly ActivityItem[],
): DisplayActivity {
  const primary =
    activities.find((activity) => activity.event.type === "context_delivery") ??
    activities[0]!;
  const observation = activities.find(
    (activity) => activity.event.type === "observation",
  );
  return {
    ...primary,
    displayId: activities.map((activity) => activity.event.id).join(":"),
    sourceActivities: activities,
    correction: observation?.correction || primary.correction,
    learnedMemories: uniqueMemories(
      activities.flatMap((activity) => activity.learnedMemories),
    ),
    deliveredMemories: uniqueMemories(
      activities.flatMap((activity) => activity.deliveredMemories),
    ),
    receipt:
      activities.find((activity) => activity.receipt !== null)?.receipt ?? null,
  };
}

const displayActivities = computed<DisplayActivity[]>(() => {
  const activities = response.value?.activities ?? [];
  if (routeEventType(route.query.type) !== "") {
    return activities.map(displayActivity);
  }

  const grouped: DisplayActivity[] = [];
  for (const activity of activities) {
    const canPair =
      activity.event.type === "context_delivery" ||
      activity.event.type === "observation";
    const key = interactionKey(activity);
    const receivedAt = Date.parse(activity.event.receivedAt);
    const matchIndex = canPair
      ? grouped.findIndex((candidate) => {
          if (interactionKey(candidate) !== key) {
            return false;
          }
          const candidateTypes = new Set(
            candidate.sourceActivities.map((source) => source.event.type),
          );
          return (
            !candidateTypes.has(activity.event.type) &&
            Math.abs(
              Date.parse(candidate.event.receivedAt) - receivedAt,
            ) <= 120_000
          );
        })
      : -1;
    if (matchIndex === -1) {
      grouped.push(displayActivity(activity));
      continue;
    }
    grouped[matchIndex] = mergeInteraction([
      ...grouped[matchIndex]!.sourceActivities,
      activity,
    ]);
  }

  return grouped.filter(
    (activity) =>
      activity.sourceActivities.some(
        (source) => source.event.type !== "observation",
      ) ||
      activity.learnedMemories.length > 0 ||
      activity.deliveredMemories.length > 0,
  );
});

const hasActiveFilters = computed(
  () =>
    routeEventType(route.query.type) !== "" ||
    routeValue(route.query.agent).trim() !== "" ||
    routeValue(route.query.connector).trim() !== "" ||
    routeValue(route.query.from) !== "" ||
    routeValue(route.query.to) !== "",
);
const totalPages = computed(() =>
  Math.max(1, Math.ceil((response.value?.total ?? 0) / PAGE_SIZE)),
);

async function applyFilters(): Promise<void> {
  filterError.value = "";
  try {
    const from = draftIso(fromDraft.value, "From");
    const to = draftIso(toDraft.value, "To");
    if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
      throw new Error("To date must be at or after the from date.");
    }
    await router.push({
      query: {
        ...(typeDraft.value === "" ? {} : { type: typeDraft.value }),
        ...(agentDraft.value.trim() === ""
          ? {}
          : { agent: agentDraft.value.trim() }),
        ...(connectorDraft.value.trim() === ""
          ? {}
          : { connector: connectorDraft.value.trim() }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      },
    });
  } catch (caught) {
    filterError.value = errorMessage(caught);
  }
}

async function clearFilters(): Promise<void> {
  typeDraft.value = "";
  agentDraft.value = "";
  connectorDraft.value = "";
  fromDraft.value = "";
  toDraft.value = "";
  filterError.value = "";
  await router.push({ query: {} });
}

async function removeFilter(
  filter: "type" | "agent" | "connector" | "from" | "to",
): Promise<void> {
  const next = { ...route.query };
  delete next[filter];
  delete next.page;
  await router.push({ query: next });
}

async function goToPage(target: number): Promise<void> {
  if (target < 1 || target > totalPages.value || target === page.value) {
    return;
  }
  const { page: _page, ...query } = route.query;
  await router.push({
    query: { ...query, ...(target === 1 ? {} : { page: String(target) }) },
  });
}

async function reloadActivity(): Promise<void> {
  await refresh();
}

const acceptanceMarkerPattern =
  /\bLORE_(?:INJECTED|CAPTURED|GREETING|RELEVANT|IRRELEVANT)_[A-Z0-9_-]+\b/giu;

function containsAcceptanceMarker(value: string): boolean {
  acceptanceMarkerPattern.lastIndex = 0;
  return acceptanceMarkerPattern.test(value);
}

function customerFacingAcceptanceText(value: string): string {
  return value
    .replace(
      /^\s*LORE_(?:RELEVANT|IRRELEVANT)_[A-Z0-9_-]+\s*:\s*/iu,
      "",
    )
    .replace(/\bLORE_GREETING_[A-Z0-9_-]+\b/giu, '"Hello from Lore"');
}

function isAcceptanceTestActivity(activity: ActivityItem): boolean {
  return (
    containsAcceptanceMarker(activity.correction) ||
    containsAcceptanceMarker(contextDeliveryTask(activity)) ||
    activity.learnedMemories.some((memory) =>
      containsAcceptanceMarker(memory.content),
    ) ||
    activity.deliveredMemories.some((memory) =>
      containsAcceptanceMarker(memory.content),
    )
  );
}

function cleanSentence(value: string): string {
  const trimmed = value
    .trim()
    .replace(
      /\s*Acknowledge this correction without modifying files\.?\s*$/iu,
      "",
    );
  return trimmed === ""
    ? trimmed
    : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function contextDeliveryTask(activity: ActivityItem): string {
  const request = activity.event.payload.request;
  if (typeof request !== "object" || request === null || !("task" in request)) {
    return "Context requested for connected work.";
  }
  const task = request.task;
  if (
    typeof task === "object" &&
    task !== null &&
    "task" in task &&
    typeof task.task === "string"
  ) {
    return task.task;
  }
  return "Context requested for connected work.";
}

function activityMessage(activity: ActivityItem): string {
  if (activity.event.type === "context_delivery") {
    return cleanSentence(
      customerFacingAcceptanceText(contextDeliveryTask(activity)),
    );
  }
  if (!isAcceptanceTestActivity(activity)) {
    return activity.correction || "No retained user message.";
  }
  const customerFacing = customerFacingAcceptanceText(activity.correction);
  if (customerFacing !== activity.correction) {
    return cleanSentence(customerFacing);
  }
  const capturedRule =
    /\bLORE_CAPTURED_[A-Z0-9_-]+\s*:\s*([\s\S]+)$/iu.exec(
      activity.correction,
    )?.[1];
  if (capturedRule !== undefined) {
    return cleanSentence(capturedRule);
  }
  return "Automated check confirming that this agent can receive and use shared Lore context.";
}

function activityMessageLabel(activity: ActivityItem): string {
  if (activity.event.type === "paired_turn") {
    return isAcceptanceTestActivity(activity)
      ? "Test correction"
      : "What you corrected";
  }
  return "What you asked";
}

function eventTypeLabel(type: EventType): string {
  return {
    paired_turn: "Correction",
    observation: "Observed activity",
    context_delivery: "Memory check",
  }[type];
}

function activityTypeLabel(activity: ActivityItem): string {
  if (activity.deliveredMemories.length > 0) {
    return "Memory shared";
  }
  if (activity.learnedMemories.length > 0) {
    return "Memory learned";
  }
  return activity.event.type === "context_delivery"
    ? "Memory checked"
    : activity.event.type === "observation"
      ? "Activity observed"
      : "Correction handled";
}

function humanReadableMemory(
  activity: ActivityItem,
  memory: ActivityItem["deliveredMemories"][number],
): string {
  if (!containsAcceptanceMarker(memory.content)) {
    return memory.content;
  }
  if (/\bLORE_GREETING_[A-Z0-9_-]+\b/iu.test(memory.content)) {
    return cleanSentence(customerFacingAcceptanceText(memory.content));
  }
  if (/\bLORE_INJECTED_[A-Z0-9_-]+\b/iu.test(memory.content)) {
    return `Lore successfully shared a previously stored test learning with ${capitalize(activity.event.agent)}.`;
  }
  const capturedRule =
    /\bLORE_CAPTURED_[A-Z0-9_-]+\s*:\s*([\s\S]+)$/iu.exec(memory.content)?.[1];
  return capturedRule === undefined
    ? memory.status === "proposed"
      ? "Lore successfully recorded this test message as a proposal."
      : "Lore successfully activated this test message as reusable memory."
    : cleanSentence(capturedRule);
}

function normalizedContent(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function isPrimaryMemory(
  activity: ActivityItem,
  memory: ActivityItem["learnedMemories"][number],
): boolean {
  return (
    activity.event.type !== "context_delivery" &&
    normalizedContent(memory.content) === normalizedContent(activity.correction)
  );
}

function primaryMessageWasApplied(activity: ActivityItem): boolean {
  const capturedIds = new Set(
    activity.learnedMemories
      .filter((memory) => isPrimaryMemory(activity, memory))
      .map((memory) => memory.id),
  );
  return activity.deliveredMemories.some(
    (memory) =>
      capturedIds.has(memory.id) || isPrimaryMemory(activity, memory),
  );
}

function capturedLearningDetails(
  activity: ActivityItem,
): ActivityItem["learnedMemories"] {
  return activity.learnedMemories.filter(
    (memory) => !isPrimaryMemory(activity, memory),
  );
}

function proposedMemories(activity: ActivityItem): ActivityItem["learnedMemories"] {
  return activity.learnedMemories.filter((memory) => memory.status === "proposed");
}

function activatedMemories(activity: ActivityItem): ActivityItem["learnedMemories"] {
  return activity.learnedMemories.filter((memory) => memory.status === "active");
}

function otherAppliedMemories(
  activity: ActivityItem,
): ActivityItem["deliveredMemories"] {
  const capturedIds = new Set(
    activity.learnedMemories.map((memory) => memory.id),
  );
  const seen = new Set<string>();
  return activity.deliveredMemories.filter((memory) => {
    const content = normalizedContent(memory.content);
    if (
      capturedIds.has(memory.id) ||
      isPrimaryMemory(activity, memory) ||
      seen.has(content)
    ) {
      return false;
    }
    seen.add(content);
    return true;
  });
}

function activityOutcome(activity: ActivityItem): string {
  if (activity.event.type === "observation") {
    const proposed = proposedMemories(activity).length;
    const activated = activatedMemories(activity).length;
    if (proposed > 0 && activated > 0) {
      return `${proposed} to review · ${activated} saved`;
    }
    if (proposed > 0) {
      return `${proposed} to review`;
    }
    return activated === 0 ? "Observed" : `${activated} saved`;
  }
  if (activity.event.type === "context_delivery") {
    const count = activity.deliveredMemories.length;
    return count === 0
      ? "No relevant memory"
      : `${count} ${count === 1 ? "memory" : "memories"} shared`;
  }
  if (activity.receipt === null) {
    return "No sharing record";
  }
  if (activity.deliveredMemories.length === 0) {
    const proposed = proposedMemories(activity).length;
    return proposed === 0 ? "No relevant memory" : `${proposed} to review`;
  }
  if (isAcceptanceTestActivity(activity)) {
    return "Sharing verified";
  }
  const otherCount = otherAppliedMemories(activity).length;
  if (otherCount === 0 && primaryMessageWasApplied(activity)) {
    return "Saved and shared";
  }
  return `${otherCount} other ${
    otherCount === 1 ? "learning" : "learnings"
  } shared`;
}

function receiptLinkLabel(activity: ActivityItem): string {
  return activity.deliveredMemories.length > 0
    ? "See why this was shared"
    : "See memory check details";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <header class="flex flex-col gap-4 border-b border-lore-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="lore-page-eyebrow">
          Workspace history
        </p>
        <h1 class="lore-page-title mt-1.5">
          Activity
        </h1>
        <p class="lore-page-description mt-1.5">
          See what Lore remembered, what it shared with your agents, and why.
        </p>
      </div>
      <button
        type="button"
        class="lore-button-secondary self-start sm:self-auto"
        :disabled="status === 'pending'"
        @click="reloadActivity"
      >
        {{ status === "pending" ? "Refreshing…" : "Refresh" }}
      </button>
    </header>

    <form
      class="mt-5 rounded-[0.625rem] border border-lore-border bg-lore-sidebar p-3"
      aria-label="Filter activity"
      @submit.prevent="applyFilters"
    >
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(5,minmax(0,1fr))_auto] xl:items-end">
        <UiField label="Event type" for="activity-type">
          <select id="activity-type" v-model="typeDraft" class="lore-select">
            <option value="">All event types</option>
            <option v-for="eventType in eventTypes" :key="eventType" :value="eventType">
              {{ eventTypeLabel(eventType) }}
            </option>
          </select>
        </UiField>
        <UiField label="Agent" for="activity-agent">
          <input
            id="activity-agent"
            v-model="agentDraft"
            class="lore-input"
            placeholder="codex"
          >
        </UiField>
        <UiField label="Connector" for="activity-connector">
          <input
            id="activity-connector"
            v-model="connectorDraft"
            class="lore-input"
            placeholder="lore-cli"
          >
        </UiField>
        <UiField label="From" for="activity-from">
          <input
            id="activity-from"
            v-model="fromDraft"
            type="datetime-local"
            class="lore-input"
          >
        </UiField>
        <UiField label="To" for="activity-to">
          <input
            id="activity-to"
            v-model="toDraft"
            type="datetime-local"
            class="lore-input"
          >
        </UiField>
        <div class="flex sm:col-span-2 sm:justify-end xl:col-span-1">
          <button type="submit" class="lore-button-primary w-full sm:w-auto">
            Apply
          </button>
        </div>
      </div>
      <UiInlineAlert
        v-if="filterError"
        class="mt-3"
        title="Activity filters are invalid"
        :message="filterError"
      />
      <div
        v-if="hasActiveFilters"
        class="mt-3 flex flex-col gap-3 border-t border-lore-border pt-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex flex-wrap gap-2">
          <button
            v-for="filter in ['type', 'agent', 'connector', 'from', 'to'] as const"
            v-show="routeValue(route.query[filter])"
            :key="filter"
            type="button"
            class="lore-focus rounded-md border border-lore-border bg-lore-raised px-2 py-1 text-xs text-lore-text-secondary hover:border-lore-border-strong"
            :aria-label="`Remove ${filter} filter ${routeValue(route.query[filter])}`"
            @click="removeFilter(filter)"
          >
            {{ filter.charAt(0).toUpperCase() + filter.slice(1) }}:
            {{ filter === "type" ? eventTypeLabel(routeEventType(route.query[filter]) as EventType) : routeValue(route.query[filter]) }}
            ×
          </button>
        </div>
        <button
          type="button"
          class="lore-button-ghost"
          @click="clearFilters"
        >
          Reset
        </button>
      </div>
    </form>

    <div class="mt-6">
      <UiSkeleton v-if="status === 'pending'" :rows="5" />

      <UiStatePanel
        v-else-if="error"
        title="Activity couldn’t be loaded"
        :description="errorMessage(error, 'activity')"
        tone="error"
      >
        <template #actions>
          <button type="button" class="lore-button-secondary" @click="reloadActivity">
            Try again
          </button>
        </template>
      </UiStatePanel>

      <UiStatePanel
        v-else-if="displayActivities.length === 0"
        :title="
          hasActiveFilters
            ? 'No matching activity'
            : response?.activities.length
              ? 'Nothing needed your attention'
              : 'No activity yet'
        "
        :description="
          hasActiveFilters
            ? 'Adjust or reset the filters to see more events.'
            : response?.activities.length
              ? 'Lore stayed quiet because these interactions did not save or share any memory.'
              : 'Once Lore remembers or shares something, you’ll see it here.'
        "
        :icon="hasActiveFilters ? 'search' : 'activity'"
      >
        <template #actions>
          <NuxtLink to="/connect" class="lore-button-primary">
            Connect an agent
          </NuxtLink>
        </template>
      </UiStatePanel>

      <section
        v-else
        class="overflow-hidden rounded-[0.625rem] border border-lore-border bg-lore-surface"
        aria-label="Recent connector activity"
      >
        <div class="flex items-center justify-between border-b border-lore-border px-4 py-3 sm:px-5">
          <p class="text-xs font-medium text-lore-text-secondary">
            Recent activity
          </p>
          <p class="text-xs tabular-nums text-lore-text-muted">
            {{ displayActivities.length }} shown
          </p>
        </div>

        <article
          v-for="activity in displayActivities"
          :key="activity.displayId"
          class="relative border-b border-lore-border px-4 py-4 last:border-b-0 sm:px-5 sm:py-5"
        >
          <div class="grid gap-4 lg:grid-cols-[10rem_minmax(0,1fr)]">
            <div>
              <div class="flex items-center gap-2">
                <span
                  class="size-2 rounded-full"
                  :class="
                    activity.receipt && activity.deliveredMemories.length > 0
                      ? 'bg-lore-success'
                      : 'bg-lore-text-muted'
                  "
                  aria-hidden="true"
                />
                <p class="text-sm font-medium text-lore-text">
                  {{ capitalize(activity.event.agent) }}
                </p>
              </div>
              <p class="mt-1 pl-4 text-xs text-lore-text-muted">
                {{ activity.event.connector }}
              </p>
              <UiDateTime
                :value="activity.event.receivedAt"
                class="mt-2 block pl-4 text-xs leading-5 text-lore-text-muted"
              />
            </div>

            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  v-if="proposedMemories(activity).length > 0"
                  class="rounded-md border border-lore-accent/30 bg-lore-accent-soft px-2 py-0.5 text-xs font-medium text-lore-accent"
                >
                  {{ proposedMemories(activity).length }} to review
                </span>
                <span
                  v-if="activatedMemories(activity).length > 0"
                  class="rounded-md border border-lore-success/30 bg-lore-success-soft px-2 py-0.5 text-xs font-medium text-lore-success"
                >
                  {{ activatedMemories(activity).length }} saved
                </span>
                <span class="px-0.5 py-0.5 text-xs font-medium text-lore-text-muted">
                  {{ activityTypeLabel(activity) }}
                </span>
                <span
                  v-if="isAcceptanceTestActivity(activity)"
                  class="px-0.5 py-0.5 text-xs font-medium text-lore-text-muted"
                >
                  Automated check
                </span>
                <span
                  class="rounded-md border px-2 py-0.5 text-xs font-medium"
                  :class="
                    activity.receipt && activity.deliveredMemories.length > 0
                      ? 'border-lore-success/30 bg-lore-success-soft text-lore-success'
                      : 'border-lore-border bg-lore-raised text-lore-text-secondary'
                  "
                >
                  {{ activityOutcome(activity) }}
                </span>
                <span
                  v-if="activity.event.redacted"
                  class="rounded-md border border-lore-warning/30 bg-lore-warning-soft px-2 py-0.5 text-xs font-medium text-lore-warning"
                >
                  Sensitive content redacted
                </span>
              </div>

              <div class="mt-3">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="lore-section-label">
                    {{ activityMessageLabel(activity) }}
                  </p>
                  <span
                    v-if="activity.event.type !== 'context_delivery' && activatedMemories(activity).length > 0"
                    class="rounded border border-lore-accent/30 bg-lore-accent-soft px-1.5 py-0.5 text-[0.625rem] font-medium text-lore-accent"
                  >
                    Activated
                  </span>
                  <span
                    v-if="activity.event.type === 'paired_turn' && primaryMessageWasApplied(activity)"
                    class="rounded border border-lore-success/30 bg-lore-success-soft px-1.5 py-0.5 text-[0.625rem] font-medium text-lore-success"
                  >
                    Shared
                  </span>
                </div>
                <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-lore-text">
                  {{ activityMessage(activity) }}
                </p>
              </div>

              <div
                v-if="
                  capturedLearningDetails(activity).length > 0 ||
                  otherAppliedMemories(activity).length > 0
                "
                class="mt-4 grid gap-4 border-t border-lore-border pt-4 md:grid-cols-2"
              >
                <section v-if="capturedLearningDetails(activity).length > 0">
                  <div class="flex items-center justify-between gap-3">
                    <h2 class="lore-section-label">
                      What Lore remembered
                    </h2>
                    <span class="text-xs tabular-nums text-lore-text-muted">
                      {{ capturedLearningDetails(activity).length }}
                    </span>
                  </div>
                  <ul class="mt-2 space-y-1">
                    <li
                      v-for="memory in capturedLearningDetails(activity)"
                      :key="memory.id"
                    >
                      <NuxtLink
                        :to="`/memories/${memory.id}`"
                        class="lore-focus block rounded-md px-2 py-1.5 text-sm leading-5 text-lore-text-secondary hover:bg-lore-hover hover:text-lore-text"
                      >
                        {{ humanReadableMemory(activity, memory) }}
                        <MemoryStatusBadge class="mt-1" :status="memory.status" />
                      </NuxtLink>
                    </li>
                  </ul>
                </section>

                <section v-if="otherAppliedMemories(activity).length > 0">
                  <div class="flex items-center justify-between gap-3">
                    <h2 class="lore-section-label">
                      {{
                        isAcceptanceTestActivity(activity)
                          ? "Validation result"
                          : "What Lore shared"
                      }}
                    </h2>
                    <span class="text-xs tabular-nums text-lore-text-muted">
                      {{ otherAppliedMemories(activity).length }}
                    </span>
                  </div>
                  <ul class="mt-2 space-y-1">
                    <li
                      v-for="memory in otherAppliedMemories(activity)"
                      :key="memory.id"
                    >
                      <NuxtLink
                        :to="`/memories/${memory.id}`"
                        class="lore-focus block rounded-md px-2 py-1.5 text-sm leading-5 text-lore-text-secondary hover:bg-lore-hover hover:text-lore-text"
                      >
                        {{ humanReadableMemory(activity, memory) }}
                      </NuxtLink>
                    </li>
                  </ul>
                </section>
              </div>

              <NuxtLink
                v-if="activity.receipt"
                :to="`/receipts/${activity.receipt.id}`"
                class="lore-link mt-4 inline-block text-xs"
              >
                {{ receiptLinkLabel(activity) }}
              </NuxtLink>

              <details class="mt-4">
                <summary
                  class="lore-focus w-fit cursor-pointer rounded text-xs font-medium text-lore-text-muted hover:text-lore-text-secondary"
                >
                  Technical details
                </summary>
                <dl class="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
                  <div>
                    <dt class="text-lore-text-muted">Session</dt>
                    <dd class="mt-1 break-all font-mono text-lore-text-secondary">
                      {{ activity.event.sessionId }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-lore-text-muted">
                      {{ activity.sourceActivities.length === 1 ? "Event" : "Events grouped" }}
                    </dt>
                    <dd class="mt-1 break-all font-mono text-lore-text-secondary">
                      {{
                        activity.sourceActivities.length === 1
                          ? activity.event.id
                          : activity.sourceActivities.length
                      }}
                    </dd>
                  </div>
                  <div v-if="activity.receipt">
                    <dt class="text-lore-text-muted">Receipt</dt>
                    <dd class="mt-1 break-all font-mono text-lore-text-secondary">
                      {{ activity.receipt.id }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-lore-text-muted">Request</dt>
                    <dd class="mt-1 break-all font-mono text-lore-text-secondary">
                      {{ activity.event.requestId }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-lore-text-muted">Captured / delivered</dt>
                    <dd class="mt-1 font-mono text-lore-text-secondary">
                      {{ activity.learnedMemories.length }} /
                      {{ activity.deliveredMemories.length }}
                    </dd>
                  </div>
                  <div
                    v-if="isAcceptanceTestActivity(activity)"
                    class="sm:col-span-2"
                  >
                    <dt class="text-lore-text-muted">Raw acceptance-test message</dt>
                    <dd class="mt-1 whitespace-pre-wrap wrap-break-word font-mono leading-5 text-lore-text-secondary">
                      {{ activity.correction }}
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
          </div>
        </article>

        <nav
          v-if="response && response.total > PAGE_SIZE"
          class="flex items-center justify-between border-t border-lore-border px-4 py-3"
          aria-label="Activity pages"
        >
          <button
            type="button"
            class="lore-button-ghost"
            :disabled="page <= 1"
            @click="goToPage(page - 1)"
          >
            Previous
          </button>
          <span class="text-xs tabular-nums text-lore-text-muted">
            Page {{ page }} of {{ totalPages }}
          </span>
          <button
            type="button"
            class="lore-button-ghost"
            :disabled="!response.hasMore"
            @click="goToPage(page + 1)"
          >
            Next
          </button>
        </nav>
      </section>
    </div>
  </div>
</template>
