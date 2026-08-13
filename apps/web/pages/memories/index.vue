<script setup lang="ts">
import type {
  ListMemoriesInput,
  Memory,
  MemoryCategory,
  MemoryStatus,
} from "@lore-co/sdk";
import { computed, ref, watch } from "vue";
import {
  categoryLabel,
  errorMessage,
  humanReadableLearningContent,
  isMemoryCategory,
  isMemoryStatus,
  isAcceptanceTestContent,
  memoryCategories,
  memoryStatuses,
  scopeLabel,
  statusLabel,
} from "~/utils/memory";

definePageMeta({ middleware: "auth" });
useHead({ title: "Learnings" });

const route = useRoute();
const router = useRouter();
const client = useSharedMemoryClient();
const PAGE_SIZE = 20;
type StatusFilter = MemoryStatus | "all";
const nonActiveMemoryStatuses = memoryStatuses.filter(
  (status) => status !== "active",
);

interface MemoryRow {
  memory: Memory;
  duplicateCount: number;
}

function routeValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function statusFilter(value: unknown): StatusFilter {
  if (value === "all") {
    return "all";
  }
  return isMemoryStatus(value) ? value : "active";
}

function isAcceptanceMemory(memory: Memory): boolean {
  return isAcceptanceTestContent(memory.content);
}

function readableMemoryContent(memory: Memory): string {
  return humanReadableLearningContent(memory.content);
}

const queryDraft = ref(routeValue(route.query.query));
const categoryDraft = ref<MemoryCategory | "">(
  isMemoryCategory(route.query.category) ? route.query.category : "",
);
const statusDraft = ref<StatusFilter>(statusFilter(route.query.status));
const projectDraft = ref(routeValue(route.query.project));
const repoDraft = ref(routeValue(route.query.repo));
const pathDraft = ref(routeValue(route.query.path));
const componentDraft = ref(routeValue(route.query.component));
const page = computed(() => {
  const parsed = Number(routeValue(route.query.page));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
});
const hasActiveFilters = computed(
  () =>
    routeValue(route.query.query).trim() !== "" ||
    isMemoryCategory(route.query.category) ||
    isMemoryStatus(route.query.status) ||
    route.query.status === "all" ||
    routeValue(route.query.project).trim() !== "" ||
    routeValue(route.query.repo).trim() !== "" ||
    routeValue(route.query.path).trim() !== "" ||
    routeValue(route.query.component).trim() !== "",
);
const activeScopeFilterCount = computed(
  () =>
    [
      route.query.project,
      route.query.repo,
      route.query.path,
      route.query.component,
    ].filter((value) => routeValue(value).trim() !== "").length,
);

watch(
  () => route.query,
  (query) => {
    queryDraft.value = routeValue(query.query);
    categoryDraft.value = isMemoryCategory(query.category)
      ? query.category
      : "";
    statusDraft.value = statusFilter(query.status);
    projectDraft.value = routeValue(query.project);
    repoDraft.value = routeValue(query.repo);
    pathDraft.value = routeValue(query.path);
    componentDraft.value = routeValue(query.component);
  },
);

const listInput = computed<ListMemoriesInput>(() => {
  const query = routeValue(route.query.query).trim();
  const category = route.query.category;
  const status = statusFilter(route.query.status);
  const project = routeValue(route.query.project).trim();
  const repo = routeValue(route.query.repo).trim();
  const path = routeValue(route.query.path).trim();
  const component = routeValue(route.query.component).trim();
  return {
    ...(query === "" ? {} : { query }),
    ...(isMemoryCategory(category) ? { category } : {}),
    ...(status === "all" ? {} : { status }),
    ...(project === "" ? {} : { project }),
    ...(repo === "" ? {} : { repo }),
    ...(path === "" ? {} : { path }),
    ...(component === "" ? {} : { component }),
    limit: PAGE_SIZE,
    offset: (page.value - 1) * PAGE_SIZE,
  };
});

const {
  data: response,
  error,
  status: requestStatus,
  refresh,
} = await useAsyncData(
  "memories-list",
  () => client.listLearnings(listInput.value),
  { watch: [listInput] },
);

async function applyFilters(): Promise<void> {
  const query = queryDraft.value.trim();
  const project = projectDraft.value.trim();
  const repo = repoDraft.value.trim();
  const path = pathDraft.value.trim();
  const component = componentDraft.value.trim();
  await router.push({
    query: {
      ...(query === "" ? {} : { query }),
      ...(categoryDraft.value === "" ? {} : { category: categoryDraft.value }),
      ...(statusDraft.value === "active"
        ? {}
        : { status: statusDraft.value }),
      ...(project === "" ? {} : { project }),
      ...(repo === "" ? {} : { repo }),
      ...(path === "" ? {} : { path }),
      ...(component === "" ? {} : { component }),
    },
  });
}

async function clearFilters(): Promise<void> {
  queryDraft.value = "";
  categoryDraft.value = "";
  statusDraft.value = "active";
  projectDraft.value = "";
  repoDraft.value = "";
  pathDraft.value = "";
  componentDraft.value = "";
  await router.push({ query: {} });
}

async function removeFilter(
  filter:
    | "query"
    | "category"
    | "status"
    | "project"
    | "repo"
    | "path"
    | "component",
): Promise<void> {
  const next = { ...route.query };
  delete next[filter];
  delete next.page;
  await router.push({ query: next });
}

async function reloadMemories(): Promise<void> {
  await refresh();
}

const totalPages = computed(() =>
  Math.max(1, Math.ceil((response.value?.total ?? 0) / PAGE_SIZE)),
);
const memoryRows = computed<MemoryRow[]>(() => {
  const rows: MemoryRow[] = [];
  const acceptanceRows = new Map<string, MemoryRow>();
  for (const memory of response.value?.memories ?? []) {
    if (!isAcceptanceMemory(memory)) {
      rows.push({ memory, duplicateCount: 1 });
      continue;
    }
    const key = [
      readableMemoryContent(memory),
      scopeLabel(memory.scope),
      memory.status,
    ].join("\u0000");
    const existing = acceptanceRows.get(key);
    if (existing === undefined) {
      const row = { memory, duplicateCount: 1 };
      acceptanceRows.set(key, row);
      rows.push(row);
    } else {
      existing.duplicateCount += 1;
    }
  }
  return rows;
});
const collapsedTestRecords = computed(() =>
  memoryRows.value.reduce(
    (total, row) => total + Math.max(0, row.duplicateCount - 1),
    0,
  ),
);
const rangeStart = computed(() =>
  response.value?.total === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1,
);
const rangeEnd = computed(() =>
  Math.min(page.value * PAGE_SIZE, response.value?.total ?? 0),
);

async function goToPage(target: number): Promise<void> {
  if (target < 1 || target > totalPages.value || target === page.value) {
    return;
  }
  const { page: _page, ...currentQuery } = route.query;
  await router.push({
    query: {
      ...currentQuery,
      ...(target === 1 ? {} : { page: String(target) }),
    },
  });
}
</script>

<template>
  <div class="mx-auto max-w-7xl">
    <header class="flex flex-col gap-4 border-b border-lore-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="lore-page-eyebrow">
          Knowledge base
        </p>
        <h1 class="lore-page-title mt-1.5">
          Learnings
        </h1>
        <p class="lore-page-description mt-1.5">
          Review the durable statements Lore can apply to relevant work.
        </p>
      </div>
      <NuxtLink to="/memories/new" class="lore-button-primary self-start sm:self-auto">
        New learning
      </NuxtLink>
    </header>

    <form
      class="sticky top-16 z-10 mt-5 rounded-[0.625rem] border border-lore-border bg-lore-sidebar p-3 lg:top-3"
      aria-label="Filter learnings"
      @submit.prevent="applyFilters"
    >
      <div class="grid gap-3 lg:grid-cols-[minmax(15rem,1fr)_12rem_11rem_auto]">
        <div>
          <label for="memory-query" class="sr-only">Search learnings</label>
          <input
            id="memory-query"
            v-model="queryDraft"
            type="search"
            placeholder="Search learnings"
            class="lore-input"
          >
        </div>
        <div>
          <label for="memory-category" class="sr-only">Category</label>
          <select
            id="memory-category"
            v-model="categoryDraft"
            class="lore-select"
            @change="applyFilters"
          >
            <option value="">All categories</option>
            <option
              v-for="category in memoryCategories"
              :key="category"
              :value="category"
            >
              {{ categoryLabel(category) }}
            </option>
          </select>
        </div>
        <div>
          <label for="memory-status" class="sr-only">Status</label>
          <select
            id="memory-status"
            v-model="statusDraft"
            class="lore-select"
            @change="applyFilters"
          >
            <option value="active">Active</option>
            <option value="all">All statuses</option>
            <option
              v-for="memoryStatus in nonActiveMemoryStatuses"
              :key="memoryStatus"
              :value="memoryStatus"
            >
              {{ statusLabel(memoryStatus) }}
            </option>
          </select>
        </div>
        <div class="flex gap-2">
          <button type="submit" class="lore-button-primary flex-1 lg:flex-none">
            Apply
          </button>
          <button
            v-if="hasActiveFilters"
            type="button"
            class="lore-button-ghost"
            @click="clearFilters"
          >
            Reset
          </button>
        </div>
      </div>

      <details
        class="group mt-3 border-t border-lore-border pt-3"
        :open="activeScopeFilterCount > 0"
      >
        <summary
          class="lore-focus flex cursor-pointer list-none items-center justify-between gap-4 rounded-md text-xs [&::-webkit-details-marker]:hidden"
        >
          <span>
            <span class="font-semibold text-lore-text-secondary">
              Advanced filters
            </span>
            <span class="ml-2 text-lore-text-muted">
              Exact project, repository, path, or component
            </span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <span
              v-if="activeScopeFilterCount > 0"
              class="rounded-md border border-lore-accent/30 bg-lore-accent-soft px-2 py-0.5 font-medium text-lore-accent"
            >
              {{ activeScopeFilterCount }} active
            </span>
            <svg
              viewBox="0 0 20 20"
              fill="none"
              class="size-4 text-lore-text-muted transition-transform group-open:rotate-180"
              aria-hidden="true"
            >
              <path
                d="m6 8 4 4 4-4"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
        </summary>

        <fieldset class="mt-3">
          <legend class="sr-only">Exact scope</legend>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <UiField label="Project" for="memory-project">
              <input
                id="memory-project"
                v-model="projectDraft"
                class="lore-input"
                placeholder="Project"
              >
            </UiField>
            <UiField label="Repository" for="memory-repo">
              <input
                id="memory-repo"
                v-model="repoDraft"
                class="lore-input"
                placeholder="owner/repository"
              >
            </UiField>
            <UiField label="Path" for="memory-path">
              <input
                id="memory-path"
                v-model="pathDraft"
                class="lore-input"
                placeholder="src/api"
              >
            </UiField>
            <UiField label="Component" for="memory-component">
              <input
                id="memory-component"
                v-model="componentDraft"
                class="lore-input"
                placeholder="billing"
              >
            </UiField>
          </div>
          <p class="mt-2 text-xs leading-5 text-lore-text-muted">
            Scope values must match stored learnings exactly.
          </p>
        </fieldset>
      </details>

      <div v-if="hasActiveFilters" class="mt-3 flex flex-wrap gap-2 border-t border-lore-border pt-3">
        <button
          v-if="routeValue(route.query.query)"
          type="button"
          class="lore-focus rounded-md border border-lore-border bg-lore-raised px-2 py-1 text-xs text-lore-text-secondary hover:border-lore-border-strong"
          @click="removeFilter('query')"
        >
          Search: {{ routeValue(route.query.query) }} ×
        </button>
        <button
          v-if="isMemoryCategory(route.query.category)"
          type="button"
          class="lore-focus rounded-md border border-lore-border bg-lore-raised px-2 py-1 text-xs text-lore-text-secondary hover:border-lore-border-strong"
          @click="removeFilter('category')"
        >
          {{ categoryLabel(route.query.category) }} ×
        </button>
        <button
          v-if="isMemoryStatus(route.query.status)"
          type="button"
          class="lore-focus rounded-md border border-lore-border bg-lore-raised px-2 py-1 text-xs text-lore-text-secondary hover:border-lore-border-strong"
          @click="removeFilter('status')"
        >
          {{ statusLabel(route.query.status) }} ×
        </button>
        <button
          v-else-if="route.query.status === 'all'"
          type="button"
          class="lore-focus rounded-md border border-lore-border bg-lore-raised px-2 py-1 text-xs text-lore-text-secondary hover:border-lore-border-strong"
          @click="removeFilter('status')"
        >
          All statuses ×
        </button>
        <button
          v-for="scopeFilter in ['project', 'repo', 'path', 'component'] as const"
          v-show="routeValue(route.query[scopeFilter])"
          :key="scopeFilter"
          type="button"
          class="lore-focus rounded-md border border-lore-border bg-lore-raised px-2 py-1 text-xs text-lore-text-secondary hover:border-lore-border-strong"
          :aria-label="`Remove ${scopeFilter} filter ${routeValue(route.query[scopeFilter])}`"
          @click="removeFilter(scopeFilter)"
        >
          {{ scopeFilter === "repo" ? "Repository" : scopeFilter.charAt(0).toUpperCase() + scopeFilter.slice(1) }}:
          {{ routeValue(route.query[scopeFilter]) }} ×
        </button>
      </div>
    </form>

    <div class="mt-5">
      <UiSkeleton v-if="requestStatus === 'pending'" :rows="7" />

      <UiStatePanel
        v-else-if="error"
        title="Learnings couldn’t be loaded"
        :description="errorMessage(error, 'learnings')"
        tone="error"
      >
        <template #actions>
          <button type="button" class="lore-button-secondary" @click="reloadMemories">
            Try again
          </button>
        </template>
      </UiStatePanel>

      <UiStatePanel
        v-else-if="response && memoryRows.length === 0"
        :title="hasActiveFilters ? 'No matching learnings' : 'No learnings yet'"
        :icon="hasActiveFilters ? 'search' : 'learning'"
        :description="
          hasActiveFilters
            ? 'Remove a filter or try a broader search.'
            : 'Create a learning here or correct a connected agent to capture one automatically.'
        "
      >
        <template #actions>
          <button
            v-if="hasActiveFilters"
            type="button"
            class="lore-button-secondary"
            @click="clearFilters"
          >
            Clear filters
          </button>
          <NuxtLink v-else to="/memories/new" class="lore-button-primary">
            Create first learning
          </NuxtLink>
        </template>
      </UiStatePanel>

      <section
        v-else-if="response"
        class="overflow-hidden rounded-[0.625rem] border border-lore-border bg-lore-surface"
        aria-labelledby="results-heading"
      >
        <div class="flex items-center justify-between border-b border-lore-border px-4 py-3">
          <div>
            <h2 id="results-heading" class="lore-section-label">
              Results
            </h2>
            <p class="mt-1 text-xs tabular-nums text-lore-text-muted">
              <template v-if="collapsedTestRecords > 0">
                {{ memoryRows.length }} shown · {{ collapsedTestRecords }}
                repeated test
                {{ collapsedTestRecords === 1 ? "record" : "records" }} combined
              </template>
              <template v-else>
                {{ rangeStart }}–{{ rangeEnd }} of {{ response.total }}
              </template>
            </p>
          </div>
          <button
            type="button"
            class="lore-button-ghost min-h-8 px-2.5 py-1 text-xs"
            @click="reloadMemories"
          >
            Refresh
          </button>
        </div>

        <div
          class="hidden grid-cols-[minmax(0,1.5fr)_minmax(10rem,0.75fr)_8rem_10rem_1.5rem] gap-4 border-b border-lore-border bg-lore-sidebar px-4 py-2 text-xs font-medium text-lore-text-muted lg:grid"
          aria-hidden="true"
        >
          <span>Statement</span>
          <span>Scope</span>
          <span>Status</span>
          <span>Updated</span>
          <span />
        </div>

        <article
          v-for="{ memory, duplicateCount } in memoryRows"
          :key="memory.id"
          class="group border-b border-lore-border px-4 py-3.5 last:border-b-0 hover:bg-lore-hover/50"
        >
          <div class="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(10rem,0.75fr)_8rem_10rem_1.5rem] lg:items-center lg:gap-4">
            <div class="min-w-0">
              <NuxtLink
                :to="`/memories/${memory.id}`"
                class="lore-focus line-clamp-2 rounded text-sm font-medium leading-5 text-lore-text hover:text-lore-accent"
              >
                {{ readableMemoryContent(memory) }}
              </NuxtLink>
              <p class="mt-1 text-xs text-lore-text-muted">
                <template v-if="isAcceptanceMemory(memory)">
                  Acceptance test
                  <template v-if="duplicateCount > 1">
                    · {{ duplicateCount }} runs combined
                  </template>
                </template>
                <template v-else>
                  {{ categoryLabel(memory.category) }} · {{ memory.source.agent }}
                </template>
              </p>
            </div>

            <div class="min-w-0">
              <p class="lore-section-label lg:hidden">
                Scope
              </p>
              <p class="mt-0.5 truncate text-sm text-lore-text-secondary lg:mt-0" :title="scopeLabel(memory.scope)">
                {{ scopeLabel(memory.scope) }}
              </p>
            </div>

            <div>
              <p class="lore-section-label lg:hidden">
                Status
              </p>
              <MemoryStatusBadge class="mt-1 lg:mt-0" :status="memory.status" />
            </div>

            <div>
              <p class="lore-section-label lg:hidden">
                Updated
              </p>
              <UiDateTime
                :value="memory.updatedAt"
                class="mt-0.5 block text-xs leading-5 text-lore-text-muted lg:mt-0"
              />
            </div>

            <NuxtLink
              :to="`/memories/${memory.id}`"
              class="lore-focus hidden rounded text-lore-text-muted group-hover:text-lore-text lg:block"
              :aria-label="`Open learning: ${readableMemoryContent(memory)}`"
            >
              →
            </NuxtLink>
          </div>
        </article>

        <nav
          v-if="response.total > PAGE_SIZE"
          class="flex items-center justify-between border-t border-lore-border px-3 py-3"
          aria-label="Learning result pages"
        >
          <button
            type="button"
            :disabled="page <= 1"
            class="lore-button-ghost"
            @click="goToPage(page - 1)"
          >
            Previous
          </button>
          <span class="text-xs tabular-nums text-lore-text-muted">
            Page {{ page }} of {{ totalPages }}
          </span>
          <button
            type="button"
            :disabled="page >= totalPages"
            class="lore-button-ghost"
            @click="goToPage(page + 1)"
          >
            Next
          </button>
        </nav>
      </section>
    </div>
  </div>
</template>
