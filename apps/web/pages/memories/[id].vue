<script setup lang="ts">
import type {
  CorrectLearningInput,
  MemoryCategory,
  MemoryScope,
  ProposalDetailResponse,
  ReviewProposalInput,
  UpdateMemoryInput,
} from "@lore-co/sdk";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { onBeforeRouteLeave } from "vue-router";
import {
  categoryLabel,
  errorMessage,
  humanReadableLearningContent,
  isAcceptanceTestContent,
  memoryCategories,
  scopeLabel,
} from "~/utils/memory";

definePageMeta({ middleware: "auth" });
useHead({ title: "Learning details" });

const route = useRoute();
const client = useSharedMemoryClient();
const toast = useToast();
const memoryId = computed(() => {
  const value = route.params.id;
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
});

async function fetchMemoryDetail(id: string) {
  const basic = await client.getLearning(id);
  if (basic.memory?.status === "proposed") {
    const proposal = await client.getProposal(id);
    return {
      inspection: {
        learning: proposal.memory,
        sourceEvent: null,
        provenance: [],
        predecessor: null,
        successor: null,
      },
      proposal,
    };
  }
  return {
    inspection: await client.inspectLearning(id),
    proposal: null,
  };
}

const {
  data: detailResponse,
  error,
  status: requestStatus,
  refresh,
} = await useAsyncData(
  "memory-detail",
  () => fetchMemoryDetail(memoryId.value),
);

watch(memoryId, () => {
  void refresh();
});

const response = computed(() => detailResponse.value?.inspection ?? null);
const proposal = computed<ProposalDetailResponse | null>(
  () => detailResponse.value?.proposal ?? null,
);
const memory = computed(() => response.value?.learning ?? null);
const predecessor = computed(() => response.value?.predecessor ?? null);
const successor = computed(() => response.value?.successor ?? null);
const provenance = computed(() => response.value?.provenance ?? []);
const isAcceptanceTest = computed(
  () =>
    memory.value !== null &&
    isAcceptanceTestContent(memory.value.content),
);
const detailTab = ref<"source" | "history" | "technical">("source");
const editing = ref(false);
const contentDraft = ref("");
const categoryDraft = ref<MemoryCategory>("other");
const projectDraft = ref("");
const repoDraft = ref("");
const pathDraft = ref("");
const componentDraft = ref("");
const saving = ref(false);
const saveError = ref("");
const correcting = ref(false);
const correctionContentDraft = ref("");
const correctionCategoryDraft = ref<MemoryCategory>("correction");
const correctionProjectDraft = ref("");
const correctionRepoDraft = ref("");
const correctionPathDraft = ref("");
const correctionComponentDraft = ref("");
const correctionConfirmed = ref(false);
const correctionPending = ref(false);
const correctionError = ref("");
const archiveDialogOpen = ref(false);
const archiving = ref(false);
const reviewScopeMode = ref<"repository" | "organization">("repository");
const reviewProjectDraft = ref("");
const reviewRepoDraft = ref("");
const reviewPathDraft = ref("");
const reviewComponentDraft = ref("");
const reviewReason = ref("");
const reviewing = ref(false);
const reviewError = ref("");

function resetDrafts(): void {
  const value = memory.value;
  if (value === null) {
    return;
  }
  contentDraft.value = value.content;
  categoryDraft.value = value.category;
  projectDraft.value = value.scope.project ?? "";
  repoDraft.value = value.scope.repo ?? "";
  pathDraft.value = value.scope.path ?? "";
  componentDraft.value = value.scope.component ?? "";
  reviewScopeMode.value =
    value.scope.repo === undefined ? "organization" : "repository";
  reviewProjectDraft.value = value.scope.project ?? "";
  reviewRepoDraft.value = value.scope.repo ?? "";
  reviewPathDraft.value = value.scope.path ?? "";
  reviewComponentDraft.value = value.scope.component ?? "";
  saveError.value = "";
}

watch(memory, resetDrafts, { immediate: true });

const canEdit = computed(
  () => memory.value !== null && memory.value.status === "active",
);
const canCorrect = computed(
  () =>
    memory.value !== null &&
    (memory.value.status === "active" || memory.value.status === "suppressed"),
);
const canForget = canCorrect;
const blockingConflict = computed(() =>
  proposal.value?.conflicts.find(
    (conflict) =>
      conflict.severity === "blocking" && conflict.resolution === null,
  ),
);
const conflictTargets = computed(
  () =>
    new Map(
      (proposal.value?.conflictTargets ?? []).map((target) => [
        target.id,
        target,
      ]),
    ),
);

function editableScope(): MemoryScope {
  return {
    ...(memory.value?.scope.organization === undefined
      ? {}
      : { organization: memory.value.scope.organization }),
    ...(projectDraft.value.trim() ? { project: projectDraft.value.trim() } : {}),
    ...(repoDraft.value.trim() ? { repo: repoDraft.value.trim() } : {}),
    ...(pathDraft.value.trim() ? { path: pathDraft.value.trim() } : {}),
    ...(componentDraft.value.trim()
      ? { component: componentDraft.value.trim() }
      : {}),
  };
}

function correctionScope(): MemoryScope {
  return {
    ...(correctionProjectDraft.value.trim()
      ? { project: correctionProjectDraft.value.trim() }
      : {}),
    ...(correctionRepoDraft.value.trim()
      ? { repo: correctionRepoDraft.value.trim() }
      : {}),
    ...(correctionPathDraft.value.trim()
      ? { path: correctionPathDraft.value.trim() }
      : {}),
    ...(correctionComponentDraft.value.trim()
      ? { component: correctionComponentDraft.value.trim() }
      : {}),
  };
}

const dirty = computed(() => {
  const value = memory.value;
  if (value === null) {
    return false;
  }
  return (
    contentDraft.value.trim() !== value.content ||
    categoryDraft.value !== value.category ||
    JSON.stringify(editableScope()) !== JSON.stringify(value.scope)
  );
});

const correctionDirty = computed(() => {
  const value = memory.value;
  if (value === null) {
    return false;
  }
  const currentScope = {
    ...(value.scope.project === undefined ? {} : { project: value.scope.project }),
    ...(value.scope.repo === undefined ? {} : { repo: value.scope.repo }),
    ...(value.scope.path === undefined ? {} : { path: value.scope.path }),
    ...(value.scope.component === undefined
      ? {}
      : { component: value.scope.component }),
  };
  return (
    correctionContentDraft.value.trim() !== value.content ||
    correctionCategoryDraft.value !== value.category ||
    JSON.stringify(correctionScope()) !== JSON.stringify(currentScope)
  );
});

const scopeEntries = computed(() => {
  const value = memory.value;
  if (value === null) {
    return [];
  }
  return [
    ["Organization", value.scope.organization],
    ["Project", value.scope.project],
    ["Repository", value.scope.repo],
    ["Path", value.scope.path],
    ["Component", value.scope.component],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
});

function beginEditing(): void {
  if (!canEdit.value) {
    return;
  }
  correcting.value = false;
  resetDrafts();
  editing.value = true;
}

function beginCorrection(): void {
  const value = memory.value;
  if (value === null || !canCorrect.value) {
    return;
  }
  editing.value = false;
  correctionContentDraft.value = value.content;
  correctionCategoryDraft.value = value.category;
  correctionProjectDraft.value = value.scope.project ?? "";
  correctionRepoDraft.value = value.scope.repo ?? "";
  correctionPathDraft.value = value.scope.path ?? "";
  correctionComponentDraft.value = value.scope.component ?? "";
  correctionConfirmed.value = false;
  correctionError.value = "";
  correcting.value = true;
}

function cancelCorrection(): void {
  if (
    correctionDirty.value &&
    !globalThis.confirm("Discard this unsaved correction?")
  ) {
    return;
  }
  correcting.value = false;
  correctionConfirmed.value = false;
  correctionError.value = "";
}

function cancelEditing(): void {
  if (
    dirty.value &&
    !globalThis.confirm("Discard your unsaved changes to this learning?")
  ) {
    return;
  }
  resetDrafts();
  editing.value = false;
}

async function saveMemory(): Promise<void> {
  saveError.value = "";
  const content = contentDraft.value.trim();
  if (!content) {
    saveError.value = "Learning statement is required.";
    return;
  }
  if (!canEdit.value) {
    saveError.value = "Only active learnings can be edited.";
    return;
  }

  const input: UpdateMemoryInput = {
    content,
    category: categoryDraft.value,
    scope: editableScope(),
  };
  saving.value = true;
  try {
    await client.updateLearning(memoryId.value, input);
    await refresh();
    editing.value = false;
    toast.show("In-place learning metadata updated.");
  } catch (caught) {
    saveError.value = errorMessage(caught);
  } finally {
    saving.value = false;
  }
}

async function correctMemory(): Promise<void> {
  correctionError.value = "";
  const content = correctionContentDraft.value.trim();
  if (!content) {
    correctionError.value = "Corrected learning statement is required.";
    return;
  }
  if (!canCorrect.value) {
    correctionError.value =
      "Only active or suppressed learnings can be corrected.";
    return;
  }
  if (!correctionConfirmed.value) {
    correctionError.value =
      "Confirm that the current learning will remain available as historical.";
    return;
  }

  const input: CorrectLearningInput = {
    content,
    category: correctionCategoryDraft.value,
    scope: correctionScope(),
    source: {
      agent: "human",
      sessionId: "lore-web-inspection",
      rawText: content,
    },
  };
  correctionPending.value = true;
  try {
    const result = await client.correctLearning(memoryId.value, input);
    correcting.value = false;
    toast.show("Correction saved. The previous learning remains in history.");
    await navigateTo(`/memories/${result.memory.id}`, { replace: true });
    await nextTick();
    detailResponse.value = await fetchMemoryDetail(result.memory.id);
  } catch (caught) {
    correctionError.value = errorMessage(caught);
  } finally {
    correctionPending.value = false;
  }
}

function reviewedScope(): MemoryScope {
  const organization = memory.value?.scope.organization;
  if (reviewScopeMode.value === "organization") {
    return organization === undefined ? {} : { organization };
  }
  return {
    ...(organization === undefined ? {} : { organization }),
    ...(reviewProjectDraft.value.trim() === ""
      ? {}
      : { project: reviewProjectDraft.value.trim() }),
    ...(reviewRepoDraft.value.trim() === ""
      ? {}
      : { repo: reviewRepoDraft.value.trim() }),
    ...(reviewPathDraft.value.trim() === ""
      ? {}
      : { path: reviewPathDraft.value.trim() }),
    ...(reviewComponentDraft.value.trim() === ""
      ? {}
      : { component: reviewComponentDraft.value.trim() }),
  };
}

async function resolveProposal(
  action: "keep_existing" | "use_proposal" | "keep_both",
): Promise<void> {
  const current = proposal.value;
  if (current === null || reviewReason.value.trim() === "") {
    reviewError.value = "Add a review reason before resolving this proposal.";
    return;
  }
  const input: ReviewProposalInput =
    action === "keep_existing"
      ? {
          decision: "reject",
          reason: reviewReason.value.trim(),
        }
      : action === "keep_both"
        ? {
            decision: "keep_both",
            reason: reviewReason.value.trim(),
            scope: reviewedScope(),
          }
        : blockingConflict.value === undefined
          ? {
              decision: "approve",
              reason: reviewReason.value.trim(),
              scope: reviewedScope(),
            }
          : {
              decision: "use_proposal",
              reason: reviewReason.value.trim(),
              targetMemoryId: blockingConflict.value.targetMemoryId,
              scope: reviewedScope(),
            };
  reviewing.value = true;
  reviewError.value = "";
  try {
    const result = await client.reviewProposal(memoryId.value, input);
    if (result.proposal.status === "deleted") {
      toast.show("Kept the existing memory and rejected the proposal.");
      await navigateTo("/memories?status=proposed");
      return;
    }
    toast.show(
      action === "keep_both"
        ? "Both memories are now active."
        : "The proposal is now active.",
    );
    await refresh();
  } catch (caught) {
    reviewError.value = errorMessage(caught, "learning");
  } finally {
    reviewing.value = false;
  }
}

async function reloadMemory(): Promise<void> {
  await refresh();
}

async function archiveMemory(): Promise<void> {
  if (!canForget.value) {
    return;
  }
  archiving.value = true;
  try {
    await client.forgetLearning(memoryId.value);
    await refresh();
    archiveDialogOpen.value = false;
    editing.value = false;
    toast.show("Learning forgotten.");
  } catch (caught) {
    toast.show(errorMessage(caught), "error");
  } finally {
    archiving.value = false;
  }
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (
    (!editing.value || !dirty.value) &&
    (!correcting.value || !correctionDirty.value)
  ) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
}

onMounted(() => window.addEventListener("beforeunload", warnBeforeUnload));
onBeforeUnmount(() => window.removeEventListener("beforeunload", warnBeforeUnload));
onBeforeRouteLeave(() => {
  if (
    (!editing.value || !dirty.value) &&
    (!correcting.value || !correctionDirty.value)
  ) {
    return true;
  }
  return globalThis.confirm("Leave this page and discard your unsaved changes?");
});
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <NuxtLink to="/memories" class="lore-link text-sm">
      ← Back to learnings
    </NuxtLink>

    <div class="mt-6">
      <UiSkeleton v-if="requestStatus === 'pending'" :rows="5" />

      <UiStatePanel
        v-else-if="error"
        title="Learning couldn’t be loaded"
        :description="errorMessage(error, 'learning')"
        tone="error"
      >
        <template #actions>
          <button type="button" class="lore-button-secondary" @click="reloadMemory">
            Try again
          </button>
        </template>
      </UiStatePanel>

      <UiStatePanel
        v-else-if="memory === null"
        title="Learning not found"
        description="This learning may have been archived, removed, or opened from an outdated link."
        icon="not-found"
      >
        <template #actions>
          <NuxtLink to="/memories" class="lore-button-secondary">
            Back to learnings
          </NuxtLink>
        </template>
      </UiStatePanel>

      <template v-else>
        <header class="border-b border-lore-border pb-5">
          <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <MemoryStatusBadge :status="memory.status" />
                <span class="text-xs text-lore-text-muted">
                  {{ categoryLabel(memory.category) }}
                </span>
                <span
                  v-if="isAcceptanceTest"
                  class="rounded-md border border-lore-border-strong bg-lore-raised px-2 py-0.5 text-xs font-medium text-lore-text-secondary"
                >
                  Acceptance test
                </span>
              </div>
              <h1 class="mt-4 max-w-4xl whitespace-pre-wrap text-xl font-semibold leading-8 tracking-tight text-lore-text sm:text-2xl">
                {{ humanReadableLearningContent(memory.content) }}
              </h1>
              <p class="mt-3 text-sm text-lore-text-secondary">
                {{ scopeLabel(memory.scope) }}
              </p>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <button
                v-if="canCorrect && !editing && !correcting"
                type="button"
                class="lore-button-primary min-h-9 px-3 py-1.5"
                @click="beginCorrection"
              >
                That was wrong
              </button>
              <button
                v-if="canEdit && !editing && !correcting"
                type="button"
                class="lore-button-secondary min-h-9 px-3 py-1.5"
                @click="beginEditing"
              >
                Edit in place
              </button>
              <button
                v-if="canForget && !editing && !correcting"
                type="button"
                class="lore-button-ghost min-h-9 px-3 py-1.5 text-lore-danger"
                @click="archiveDialogOpen = true"
              >
                Forget
              </button>
            </div>
          </div>
        </header>

        <section
          v-if="proposal"
          class="mt-6 overflow-hidden rounded-[0.625rem] border border-lore-accent/40 bg-lore-surface"
          aria-labelledby="proposal-review-heading"
        >
          <div class="border-b border-lore-border px-5 py-4">
            <h2 id="proposal-review-heading" class="text-sm font-semibold text-lore-text">
              Review proposal
            </h2>
            <p class="mt-1 text-xs leading-5 text-lore-text-secondary">
              This statement is not retrievable or injectable until a reviewer
              activates it.
            </p>
          </div>

          <div class="space-y-6 p-5">
            <section aria-labelledby="conflict-evidence-heading">
              <div class="flex items-center justify-between gap-3">
                <h3 id="conflict-evidence-heading" class="text-sm font-semibold text-lore-text">
                  Conflict evidence
                </h3>
                <span class="text-xs text-lore-text-muted">
                  {{ proposal.conflicts.length }}
                  {{ proposal.conflicts.length === 1 ? "signal" : "signals" }}
                </span>
              </div>
              <p
                v-if="proposal.conflicts.length === 0"
                class="mt-3 text-sm leading-6 text-lore-text-secondary"
              >
                No deterministic, lexical, semantic, or model-assisted conflict
                signals were found.
              </p>
              <ul v-else class="mt-3 divide-y divide-lore-border border-y border-lore-border">
                <li
                  v-for="conflict in proposal.conflicts"
                  :key="conflict.id"
                  class="py-4"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs font-semibold capitalize text-lore-text">
                      {{ conflict.detector }}
                    </span>
                    <span
                      class="rounded border px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide"
                      :class="
                        conflict.severity === 'blocking'
                          ? 'border-lore-danger/30 bg-lore-danger-soft text-lore-danger'
                          : 'border-lore-warning/30 bg-lore-warning-soft text-lore-warning'
                      "
                    >
                      {{ conflict.severity }}
                    </span>
                  </div>
                  <p class="mt-2 text-sm leading-6 text-lore-text-secondary">
                    {{ conflict.evidence.summary }}
                  </p>
                  <div
                    v-if="conflictTargets.get(conflict.targetMemoryId)"
                    class="mt-3 rounded-md border border-lore-border bg-lore-raised p-3"
                  >
                    <p class="lore-section-label">Existing memory</p>
                    <NuxtLink
                      :to="`/memories/${conflict.targetMemoryId}`"
                      class="lore-link mt-1 block text-sm leading-6"
                    >
                      {{ conflictTargets.get(conflict.targetMemoryId)?.content }}
                    </NuxtLink>
                  </div>
                </li>
              </ul>
            </section>

            <fieldset class="border-t border-lore-border pt-5">
              <legend class="text-sm font-semibold text-lore-text">
                Activation scope
              </legend>
              <p class="mt-1 text-xs leading-5 text-lore-text-muted">
                Keep repository scope, edit it, or promote this proposal to the
                organization before activation.
              </p>
              <div class="mt-4 flex flex-wrap gap-4">
                <label class="flex items-center gap-2 text-sm text-lore-text-secondary">
                  <input
                    v-model="reviewScopeMode"
                    type="radio"
                    value="repository"
                    :disabled="reviewing"
                  >
                  Repository scope
                </label>
                <label class="flex items-center gap-2 text-sm text-lore-text-secondary">
                  <input
                    v-model="reviewScopeMode"
                    type="radio"
                    value="organization"
                    :disabled="reviewing"
                  >
                  Promote organization-wide
                </label>
              </div>
              <div
                v-if="reviewScopeMode === 'repository'"
                class="mt-4 grid gap-4 sm:grid-cols-2"
              >
                <UiField label="Project" for="proposal-project">
                  <input
                    id="proposal-project"
                    v-model="reviewProjectDraft"
                    class="lore-input"
                    :disabled="reviewing"
                  >
                </UiField>
                <UiField label="Repository" for="proposal-repo">
                  <input
                    id="proposal-repo"
                    v-model="reviewRepoDraft"
                    class="lore-input"
                    :disabled="reviewing"
                  >
                </UiField>
                <UiField label="Path" for="proposal-path">
                  <input
                    id="proposal-path"
                    v-model="reviewPathDraft"
                    class="lore-input"
                    :disabled="reviewing"
                  >
                </UiField>
                <UiField label="Component" for="proposal-component">
                  <input
                    id="proposal-component"
                    v-model="reviewComponentDraft"
                    class="lore-input"
                    :disabled="reviewing"
                  >
                </UiField>
              </div>
              <p
                v-else
                class="mt-4 rounded-md border border-lore-warning/30 bg-lore-warning-soft p-3 text-xs leading-5 text-lore-text-secondary"
              >
                Promotion makes the statement eligible across repositories in
                {{ memory.scope.organization ?? "this workspace" }} after activation.
              </p>
            </fieldset>

            <UiField label="Review reason" for="proposal-review-reason" required>
              <textarea
                id="proposal-review-reason"
                v-model="reviewReason"
                rows="3"
                class="lore-textarea resize-y"
                required
                :disabled="reviewing"
                placeholder="Explain why this resolution is correct."
              />
            </UiField>

            <UiInlineAlert
              v-if="reviewError"
              title="Proposal wasn’t resolved"
              :message="reviewError"
            />
          </div>

          <div class="flex flex-col gap-2 border-t border-lore-border px-5 py-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              class="lore-button-secondary"
              :disabled="reviewing"
              @click="resolveProposal('keep_existing')"
            >
              Keep existing
            </button>
            <button
              type="button"
              class="lore-button-primary"
              :disabled="reviewing"
              @click="resolveProposal('use_proposal')"
            >
              Use proposal
            </button>
            <button
              type="button"
              class="lore-button-secondary"
              :disabled="reviewing"
              @click="resolveProposal('keep_both')"
            >
              Keep both
            </button>
          </div>
        </section>

        <form
          v-if="correcting"
          class="mt-6 rounded-[0.625rem] border border-lore-accent/40 bg-lore-surface"
          aria-labelledby="correction-heading"
          @submit.prevent="correctMemory"
        >
          <div class="border-b border-lore-border px-5 py-4">
            <h2 id="correction-heading" class="text-sm font-semibold text-lore-text">
              Create a correction
            </h2>
            <p class="mt-1 text-xs leading-5 text-lore-text-secondary">
              Use this when the learning itself is no longer correct. Lore will
              use the corrected version going forward and keep this one in
              read-only history.
            </p>
          </div>
          <div class="space-y-5 p-5">
            <UiField label="Corrected statement" for="correction-content" required>
              <textarea
                id="correction-content"
                v-model="correctionContentDraft"
                rows="6"
                required
                class="lore-textarea resize-y"
                :disabled="correctionPending"
              />
            </UiField>

            <UiField label="Category" for="correction-category">
              <select
                id="correction-category"
                v-model="correctionCategoryDraft"
                class="lore-select"
                :disabled="correctionPending"
              >
                <option
                  v-for="category in memoryCategories"
                  :key="category"
                  :value="category"
                >
                  {{ categoryLabel(category) }}
                </option>
              </select>
            </UiField>

            <div class="border-t border-lore-border pt-5">
              <h3 class="text-sm font-semibold text-lore-text">Correction scope</h3>
              <p class="mt-1 text-xs leading-5 text-lore-text-muted">
                Organization remains {{ memory.scope.organization ?? "workspace-owned" }}.
                Narrow the corrected version with exact scope values as needed.
              </p>
              <div class="mt-4 grid gap-4 sm:grid-cols-2">
                <UiField label="Project" for="correction-project">
                  <input
                    id="correction-project"
                    v-model="correctionProjectDraft"
                    class="lore-input"
                    :disabled="correctionPending"
                  >
                </UiField>
                <UiField label="Repository" for="correction-repo" hint="owner/repository">
                  <input
                    id="correction-repo"
                    v-model="correctionRepoDraft"
                    class="lore-input"
                    :disabled="correctionPending"
                  >
                </UiField>
                <UiField label="Path" for="correction-path">
                  <input
                    id="correction-path"
                    v-model="correctionPathDraft"
                    class="lore-input"
                    :disabled="correctionPending"
                  >
                </UiField>
                <UiField label="Component" for="correction-component">
                  <input
                    id="correction-component"
                    v-model="correctionComponentDraft"
                    class="lore-input"
                    :disabled="correctionPending"
                  >
                </UiField>
              </div>
            </div>

            <label class="flex items-start gap-3 rounded-lg border border-lore-warning/40 bg-lore-warning-soft p-4 text-sm leading-6 text-lore-text-secondary">
              <input
                v-model="correctionConfirmed"
                type="checkbox"
                class="mt-1 size-4 shrink-0"
                :disabled="correctionPending"
              >
              <span>
                Keep the current learning as read-only history and use this
                corrected version going forward.
              </span>
            </label>

            <UiInlineAlert
              v-if="correctionError"
              title="Correction wasn’t saved"
              :message="correctionError"
            />
          </div>
          <div class="flex flex-col-reverse gap-3 border-t border-lore-border px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              class="lore-button-ghost"
              :disabled="correctionPending"
              @click="cancelCorrection"
            >
              Cancel
            </button>
            <button
              type="submit"
              class="lore-button-primary"
              :disabled="correctionPending || !correctionDirty || !correctionConfirmed"
            >
              {{ correctionPending ? "Saving correction…" : "Save correction" }}
            </button>
          </div>
        </form>

        <form
          v-else-if="editing"
          class="mt-6 rounded-[0.625rem] border border-lore-border bg-lore-surface"
          @submit.prevent="saveMemory"
        >
          <div class="border-b border-lore-border px-5 py-4">
            <h2 class="text-sm font-semibold text-lore-text">Edit learning</h2>
            <p class="mt-1 text-xs text-lore-text-muted">
              Fix a typo or metadata in place. For a change in meaning, use
              That was wrong so the prior statement remains in history.
            </p>
          </div>
          <div class="space-y-5 p-5">
            <UiField label="Statement" for="edit-content" required>
              <textarea
                id="edit-content"
                v-model="contentDraft"
                rows="6"
                required
                class="lore-textarea resize-y"
              />
            </UiField>

            <UiField label="Category" for="edit-category">
              <select id="edit-category" v-model="categoryDraft" class="lore-select">
                <option
                  v-for="category in memoryCategories"
                  :key="category"
                  :value="category"
                >
                  {{ categoryLabel(category) }}
                </option>
              </select>
            </UiField>

            <div class="border-t border-lore-border pt-5">
              <h3 class="text-sm font-semibold text-lore-text">Scope</h3>
              <p class="mt-1 text-xs text-lore-text-muted">
                Organization is server-owned and remains
                {{ memory.scope.organization ?? "workspace-wide" }}. Empty scope
                fields make the learning available more broadly.
              </p>
              <div class="mt-4 grid gap-4 sm:grid-cols-2">
                <UiField label="Project" for="edit-project">
                  <input id="edit-project" v-model="projectDraft" class="lore-input">
                </UiField>
                <UiField label="Repository" for="edit-repo" hint="owner/repository">
                  <input id="edit-repo" v-model="repoDraft" class="lore-input">
                </UiField>
                <UiField label="Path" for="edit-path">
                  <input id="edit-path" v-model="pathDraft" class="lore-input">
                </UiField>
                <UiField label="Component" for="edit-component">
                  <input id="edit-component" v-model="componentDraft" class="lore-input">
                </UiField>
              </div>
            </div>

            <UiInlineAlert
              v-if="saveError"
              title="Changes weren’t saved"
              :message="saveError"
            />
          </div>
          <div class="flex items-center justify-between gap-3 border-t border-lore-border px-5 py-4">
            <p class="text-xs text-lore-text-muted">
              {{ dirty ? "Unsaved changes" : "No changes" }}
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                class="lore-button-ghost"
                :disabled="saving"
                @click="cancelEditing"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="lore-button-primary"
                :disabled="saving || !dirty"
              >
                {{ saving ? "Saving…" : "Save in place" }}
              </button>
            </div>
          </div>
        </form>

        <div v-else class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <section class="min-w-0">
            <div class="flex gap-1 border-b border-lore-border" role="tablist" aria-label="Learning information">
              <button
                v-for="tab in ['source', 'history', 'technical'] as const"
                :key="tab"
                type="button"
                role="tab"
                class="lore-focus -mb-px border-b-2 px-3 py-2.5 text-sm font-medium capitalize"
                :class="
                  detailTab === tab
                    ? 'border-lore-accent text-lore-text'
                    : 'border-transparent text-lore-text-muted hover:text-lore-text-secondary'
                "
                :aria-selected="detailTab === tab"
                @click="detailTab = tab"
              >
                {{ tab }}
              </button>
            </div>

            <div class="py-6">
              <section v-if="detailTab === 'source'" aria-labelledby="source-heading">
                <h2 id="source-heading" class="text-sm font-semibold text-lore-text">
                  Captured source
                </h2>
                <p class="mt-2 text-sm leading-6 text-lore-text-secondary">
                  Captured from {{ memory.source.agent }}
                  <template v-if="memory.source.sessionId">
                    during session {{ memory.source.sessionId }}
                  </template>.
                </p>
                <div class="mt-5 border-t border-lore-border pt-4">
                  <p class="lore-section-label">
                    Original text
                  </p>
                  <pre
                    v-if="memory.source.rawText"
                    class="mt-3 max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word font-sans text-sm leading-6 text-lore-text-secondary"
                  >{{ memory.source.rawText }}</pre>
                  <p v-else class="mt-3 text-sm text-lore-text-muted">
                    Original source text was not retained.
                  </p>
                </div>

                <div class="mt-6">
                  <h3 class="lore-section-label">
                    Provenance records
                  </h3>
                  <ul
                    v-if="provenance.length > 0"
                    class="mt-3 divide-y divide-lore-border"
                  >
                    <li
                      v-for="{ record, event: provenanceEvent } in provenance"
                      :key="record.id"
                      class="py-4 first:pt-0 last:pb-0"
                    >
                      <p class="whitespace-pre-wrap text-sm leading-6 text-lore-text-secondary">
                        {{ record.excerpt }}
                      </p>
                      <dl class="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                        <div>
                          <dt class="text-lore-text-muted">Connector event</dt>
                          <dd class="mt-1 text-lore-text-secondary">
                            {{ provenanceEvent.connector }} · {{ provenanceEvent.type }}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-lore-text-muted">Agent / session</dt>
                          <dd class="mt-1 text-lore-text-secondary">
                            {{ provenanceEvent.agent }} · {{ provenanceEvent.sessionId }}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-lore-text-muted">External event</dt>
                          <dd class="mt-1 break-all font-mono text-lore-text-secondary">
                            {{ provenanceEvent.externalEventId }}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-lore-text-muted">Captured</dt>
                          <dd class="mt-1 text-lore-text-secondary">
                            <UiDateTime :value="record.createdAt" />
                          </dd>
                        </div>
                      </dl>
                    </li>
                  </ul>
                  <p v-else class="mt-3 text-sm text-lore-text-muted">
                    No connector-event provenance is attached. The captured
                    source above is the complete retained source for this record.
                  </p>
                </div>
              </section>

              <section v-else-if="detailTab === 'history'" aria-labelledby="history-heading">
                <h2 id="history-heading" class="text-sm font-semibold text-lore-text">
                  Record history
                </h2>
                <ol class="mt-5 border-l border-lore-border pl-5">
                  <li class="relative pb-6">
                    <span class="absolute left-[-1.45rem] top-1.5 size-2 rounded-full bg-lore-accent" />
                    <p class="text-sm font-medium text-lore-text">Last updated</p>
                    <UiDateTime
                      :value="memory.updatedAt"
                      class="mt-1 block text-xs text-lore-text-muted"
                    />
                  </li>
                  <li v-if="successor" class="relative pb-6">
                    <span class="absolute left-[-1.45rem] top-1.5 size-2 rounded-full bg-lore-accent" />
                    <p class="text-sm font-medium text-lore-text">
                      Replaced by a newer learning
                    </p>
                    <NuxtLink
                      :to="`/memories/${successor.id}`"
                      class="lore-link mt-1 block text-sm"
                    >
                      {{ humanReadableLearningContent(successor.content) }}
                    </NuxtLink>
                  </li>
                  <li v-if="predecessor" class="relative pb-6">
                    <span class="absolute left-[-1.45rem] top-1.5 size-2 rounded-full bg-lore-warning" />
                    <p class="text-sm font-medium text-lore-text">Replaced an earlier learning</p>
                    <NuxtLink
                      :to="`/memories/${predecessor.id}`"
                      class="lore-link mt-1 block text-sm"
                    >
                      {{ humanReadableLearningContent(predecessor.content) }}
                    </NuxtLink>
                  </li>
                  <li class="relative">
                    <span class="absolute left-[-1.45rem] top-1.5 size-2 rounded-full bg-lore-text-muted" />
                    <p class="text-sm font-medium text-lore-text">Created</p>
                    <UiDateTime
                      :value="memory.createdAt"
                      class="mt-1 block text-xs text-lore-text-muted"
                    />
                  </li>
                </ol>
              </section>

              <section v-else aria-labelledby="technical-heading">
                <h2 id="technical-heading" class="text-sm font-semibold text-lore-text">
                  Technical details
                </h2>
                <p class="mt-2 text-sm text-lore-text-secondary">
                  Internal identifiers for diagnostics and API support.
                </p>
                <dl class="mt-5 divide-y divide-lore-border border-y border-lore-border">
                  <div class="py-3">
                    <dt class="text-xs text-lore-text-muted">Learning ID</dt>
                    <dd class="mt-1 break-all font-mono text-xs text-lore-text-secondary">
                      {{ memory.id }}
                    </dd>
                  </div>
                  <div class="py-3">
                    <dt class="text-xs text-lore-text-muted">Fingerprint</dt>
                    <dd class="mt-1 break-all font-mono text-xs text-lore-text-secondary">
                      {{ memory.fingerprint }}
                    </dd>
                  </div>
                  <div v-if="memory.source.sessionId" class="py-3">
                    <dt class="text-xs text-lore-text-muted">Session ID</dt>
                    <dd class="mt-1 break-all font-mono text-xs text-lore-text-secondary">
                      {{ memory.source.sessionId }}
                    </dd>
                  </div>
                  <div v-if="memory.source.messageId" class="py-3">
                    <dt class="text-xs text-lore-text-muted">Message ID</dt>
                    <dd class="mt-1 break-all font-mono text-xs text-lore-text-secondary">
                      {{ memory.source.messageId }}
                    </dd>
                  </div>
                  <div v-if="response?.sourceEvent" class="py-3">
                    <dt class="text-xs text-lore-text-muted">Source connector event</dt>
                    <dd class="mt-1 break-all font-mono text-xs text-lore-text-secondary">
                      {{ response.sourceEvent.id }} ·
                      {{ response.sourceEvent.connector }} ·
                      {{ response.sourceEvent.externalEventId }}
                    </dd>
                  </div>
                  <div v-if="isAcceptanceTest" class="py-3">
                    <dt class="text-xs text-lore-text-muted">Raw test statement</dt>
                    <dd class="mt-1 whitespace-pre-wrap wrap-break-word font-mono text-xs leading-5 text-lore-text-secondary">
                      {{ memory.content }}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          </section>

          <aside>
            <section class="rounded-[0.625rem] border border-lore-border bg-lore-surface">
              <div class="border-b border-lore-border px-4 py-3">
                <h2 class="lore-section-label">
                  Applies to
                </h2>
              </div>
              <dl v-if="scopeEntries.length > 0" class="divide-y divide-lore-border">
                <div v-for="[label, value] in scopeEntries" :key="label" class="px-4 py-3">
                  <dt class="text-xs text-lore-text-muted">{{ label }}</dt>
                  <dd class="mt-1 wrap-break-word text-sm text-lore-text-secondary">
                    {{ value }}
                  </dd>
                </div>
              </dl>
              <p v-else class="px-4 py-4 text-sm leading-6 text-lore-text-secondary">
                Workspace-wide
              </p>
            </section>

            <p
              v-if="!canEdit"
              class="mt-4 rounded-lg border border-lore-border bg-lore-raised p-3 text-xs leading-5 text-lore-text-muted"
            >
              Suppressed, forgotten, and replaced learnings cannot be edited
              in place.
            </p>
          </aside>
        </div>
      </template>
    </div>

    <UiConfirmDialog
      :open="archiveDialogOpen"
      title="Forget this learning?"
      description="It will stop being injected into future work but remain available in history."
      confirm-label="Forget learning"
      :pending="archiving"
      @cancel="archiveDialogOpen = false"
      @confirm="archiveMemory"
    />
  </div>
</template>
