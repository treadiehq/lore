<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    message: string;
  }>(),
  {
    title: "Something went wrong",
  },
);
</script>

<template>
  <div
    class="rounded-lg border border-lore-danger/30 bg-lore-danger-soft/50 p-3"
    role="alert"
  >
    <div class="flex items-start gap-3">
      <span
        class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-lore-danger/25 bg-lore-danger-soft text-lore-danger"
        aria-hidden="true"
      >
        <svg viewBox="0 0 20 20" fill="none" class="size-3.5">
          <path
            d="M10 5.5v4m0 3v.05M4.2 15.5h11.6a1.5 1.5 0 0 0 1.3-2.25L11.3 3.2a1.5 1.5 0 0 0-2.6 0L2.9 13.25a1.5 1.5 0 0 0 1.3 2.25Z"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <div class="min-w-0">
        <p class="text-sm font-medium text-lore-text">{{ title }}</p>
        <p class="mt-1 text-sm leading-5 text-lore-text-secondary">
          {{ message }}
        </p>
        <div v-if="$slots.actions" class="mt-3">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </div>
</template>
