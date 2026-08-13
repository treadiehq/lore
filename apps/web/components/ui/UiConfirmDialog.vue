<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    pendingLabel?: string;
    pending?: boolean;
  }>(),
  {
    confirmLabel: "Confirm",
    pendingLabel: "Working…",
    pending: false,
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const cancelButton = ref<HTMLButtonElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      return;
    }
    await nextTick();
    cancelButton.value?.focus();
  },
);

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !props.pending) {
    emit("cancel");
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      @keydown="handleKeydown"
    >
      <button
        type="button"
        class="absolute inset-0 cursor-default"
        aria-label="Close dialog"
        :disabled="pending"
        @click="$emit('cancel')"
      />
      <section
        class="relative z-10 w-full max-w-md rounded-[0.625rem] border border-lore-border bg-lore-raised p-5"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
      >
        <h2 id="confirm-dialog-title" class="text-base font-semibold text-lore-text">
          {{ title }}
        </h2>
        <p
          id="confirm-dialog-description"
          class="mt-2 text-sm leading-6 text-lore-text-secondary"
        >
          {{ description }}
        </p>
        <div class="mt-6 flex justify-end gap-2">
          <button
            ref="cancelButton"
            type="button"
            class="lore-button-secondary"
            :disabled="pending"
            @click="$emit('cancel')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="lore-button-danger"
            :disabled="pending"
            @click="$emit('confirm')"
          >
            {{ pending ? pendingLabel : confirmLabel }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
