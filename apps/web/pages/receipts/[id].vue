<script setup lang="ts">
import type {
  DeliveryFeedbackAction,
  DeliveryReceiptDetail,
  Memory,
} from "@lore-co/sdk";
import { computed, ref } from "vue";
import { errorMessage } from "~/utils/memory";

definePageMeta({ middleware: "auth" });
useHead({ title: "Lore delivery receipt" });

const route = useRoute();
const client = useSharedMemoryClient();
const toast = useToast();
const receiptId = computed(() => {
  const value = route.params.id;
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
});

const {
  data: detail,
  error,
  status,
  refresh,
} = await useAsyncData<DeliveryReceiptDetail>(
  "delivery-receipt",
  () => client.getDeliveryReceipt(receiptId.value),
  { watch: [receiptId] },
);

const feedbackTarget = ref<{
  memoryId: string;
  action: DeliveryFeedbackAction;
} | null>(null);
const feedbackPending = ref(false);
const correctionTarget = ref<Memory | null>(null);
const correctionDraft = ref("");
const correctionPending = ref(false);

const memoryById = computed(
  () => new Map((detail.value?.memories ?? []).map((memory) => [memory.id, memory])),
);

function alreadySuppressed(memoryId: string): boolean {
  return (
    detail.value?.feedback.some(
      (feedback) => feedback.memoryId === memoryId,
    ) ?? false
  );
}

function openFeedback(
  memoryId: string,
  action: DeliveryFeedbackAction,
): void {
  feedbackTarget.value = { memoryId, action };
}

async function submitFeedback(): Promise<void> {
  const target = feedbackTarget.value;
  if (target === null) {
    return;
  }
  feedbackPending.value = true;
  try {
    const result = await client.recordDeliveryFeedback(receiptId.value, target);
    feedbackTarget.value = null;
    await refresh();
    if (target.action === "wrong") {
      correctionTarget.value = result.memory;
      correctionDraft.value = "";
      toast.show("Learning suppressed. It will not be injected again.");
    } else {
      toast.show("Learning forgotten. It will not be injected again.");
    }
  } catch (caught) {
    toast.show(errorMessage(caught), "error");
  } finally {
    feedbackPending.value = false;
  }
}

async function saveReplacement(): Promise<void> {
  const target = correctionTarget.value;
  const content = correctionDraft.value.trim();
  if (target === null || content === "") {
    return;
  }
  correctionPending.value = true;
  try {
    const result = await client.correctLearning(target.id, {
      content,
      scope: target.scope,
      category: "correction",
      source: {
        agent: "human",
        sessionId: `delivery-receipt:${receiptId.value}`,
        rawText: content,
      },
    });
    correctionTarget.value = null;
    correctionDraft.value = "";
    toast.show("Corrected learning saved.");
    await navigateTo(`/memories/${result.memory.id}`);
  } catch (caught) {
    toast.show(errorMessage(caught), "error");
  } finally {
    correctionPending.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <NuxtLink to="/activity" class="lore-link text-sm">
      ← Back to Activity
    </NuxtLink>

    <header class="mt-6 border-b border-lore-border pb-5">
      <p class="lore-page-eyebrow">Injection proof</p>
      <h1 class="lore-page-title mt-1.5">Lore delivery receipt</h1>
      <p class="lore-page-description mt-1.5">
        Exact learnings Lore gave the agent for this turn. Delivery proves
        context injection, not that the model followed it.
      </p>
    </header>

    <div class="mt-6">
      <UiSkeleton v-if="status === 'pending'" :rows="4" />

      <UiStatePanel
        v-else-if="error"
        title="Receipt couldn’t be loaded"
        :description="errorMessage(error)"
        tone="error"
      >
        <template #actions>
          <button
            type="button"
            class="lore-button-secondary"
            @click="() => refresh()"
          >
            Try again
          </button>
        </template>
      </UiStatePanel>

      <UiStatePanel
        v-else-if="!detail"
        title="Receipt not found"
        description="This delivery receipt is unavailable or belongs to another workspace."
        icon="not-found"
      />

      <template v-else>
        <section class="rounded-[0.625rem] border border-lore-border bg-lore-surface">
          <div class="grid gap-4 border-b border-lore-border p-4 text-sm sm:grid-cols-3">
            <div>
              <p class="lore-section-label">Agent</p>
              <p class="mt-1 capitalize text-lore-text">{{ detail.event.agent }}</p>
            </div>
            <div>
              <p class="lore-section-label">Delivered</p>
              <UiDateTime
                :value="detail.receipt.deliveredAt"
                class="mt-1 block text-lore-text"
              />
            </div>
            <div>
              <p class="lore-section-label">Policy</p>
              <p class="mt-1 font-mono text-xs text-lore-text-secondary">
                {{ detail.receipt.retrievalPolicyVersion }}
              </p>
            </div>
          </div>

          <UiStatePanel
            v-if="detail.receipt.hits.length === 0"
            title="Lore stayed silent"
            description="No learning was injected because nothing cleared the relevance threshold."
            icon="search"
          />

          <template v-else>
            <article
              v-for="hit in detail.receipt.hits"
              :key="hit.memoryId"
              class="border-b border-lore-border p-4 last:border-b-0 sm:p-5"
            >
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <p class="lore-section-label">Injected learning</p>
                <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-lore-text">
                  {{ hit.content }}
                </p>
                <div class="mt-3 flex flex-wrap gap-2">
                  <span
                    v-for="reason in hit.reasons"
                    :key="reason"
                    class="rounded-md border border-lore-border bg-lore-raised px-2 py-0.5 text-xs capitalize text-lore-text-secondary"
                  >
                    {{ reason }}
                  </span>
                </div>
              </div>

              <div class="flex shrink-0 flex-wrap gap-2">
                <template v-if="!alreadySuppressed(hit.memoryId)">
                  <button
                    type="button"
                    class="lore-button-secondary min-h-9 px-3 py-1.5"
                    @click="openFeedback(hit.memoryId, 'wrong')"
                  >
                    That was wrong
                  </button>
                  <button
                    type="button"
                    class="lore-button-ghost min-h-9 px-3 py-1.5 text-lore-danger"
                    @click="openFeedback(hit.memoryId, 'forget')"
                  >
                    Forget
                  </button>
                </template>
                <span
                  v-else
                  class="rounded-md border border-lore-warning/30 bg-lore-warning-soft px-2.5 py-1.5 text-xs font-medium text-lore-warning"
                >
                  Suppressed
                </span>
              </div>
            </div>

            <NuxtLink
              v-if="memoryById.has(hit.memoryId)"
              :to="`/memories/${hit.memoryId}`"
              class="lore-link mt-4 inline-block text-xs"
            >
              Inspect source and scope
            </NuxtLink>
            </article>
          </template>
        </section>

        <form
          v-if="correctionTarget"
          class="mt-5 rounded-[0.625rem] border border-lore-accent/40 bg-lore-surface p-5"
          @submit.prevent="saveReplacement"
        >
          <h2 class="text-sm font-semibold text-lore-text">
            Teach the corrected version
          </h2>
          <p class="mt-1 text-xs leading-5 text-lore-text-secondary">
            Optional. The wrong learning is already suppressed.
          </p>
          <UiField class="mt-4" label="Corrected learning" for="replacement-content">
            <textarea
              id="replacement-content"
              v-model="correctionDraft"
              rows="4"
              required
              class="lore-textarea resize-y"
              :disabled="correctionPending"
            />
          </UiField>
          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              class="lore-button-ghost"
              :disabled="correctionPending"
              @click="correctionTarget = null"
            >
              Skip
            </button>
            <button
              type="submit"
              class="lore-button-primary"
              :disabled="correctionPending || correctionDraft.trim() === ''"
            >
              {{ correctionPending ? "Saving…" : "Save correction" }}
            </button>
          </div>
        </form>
      </template>
    </div>

    <UiConfirmDialog
      :open="feedbackTarget !== null"
      :title="
        feedbackTarget?.action === 'wrong'
          ? 'Mark this learning as wrong?'
          : 'Forget this learning?'
      "
      :description="
        feedbackTarget?.action === 'wrong'
          ? 'It will be suppressed immediately. You can optionally teach a corrected version next.'
          : 'It will stop being injected into future agent sessions.'
      "
      :confirm-label="
        feedbackTarget?.action === 'wrong' ? 'Suppress learning' : 'Forget learning'
      "
      :pending="feedbackPending"
      @cancel="feedbackTarget = null"
      @confirm="submitFeedback"
    />
  </div>
</template>
