<script setup lang="ts">
defineProps<{
  email: string;
  pending: boolean;
}>();

defineEmits<{
  resend: [];
}>();
</script>

<template>
  <div class="rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6">
    <div class="flex items-start gap-3">
      <span
        class="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-lore-border-strong bg-lore-raised text-lore-accent"
        aria-hidden="true"
      >
        <svg viewBox="0 0 20 20" fill="none" class="size-4.5">
          <path
            d="M3.5 5.5h13A1.5 1.5 0 0 1 18 7v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5V7a1.5 1.5 0 0 1 1.5-1.5Z"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="m3 6.5 5.5 4a2.5 2.5 0 0 0 3 0l5.5-4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <div>
        <p class="text-sm font-medium text-lore-text">
          Link sent to {{ email }}
        </p>
        <p class="mt-1 text-sm leading-6 text-lore-text-secondary">
          Open the email on this device and follow the link. You can close this
          page after signing in.
        </p>
      </div>
    </div>

    <div class="mt-5 border-t border-lore-border pt-5">
      <p class="text-xs leading-5 text-lore-text-muted">
        Didn’t receive it? Check spam, verify the address, or request another
        link. Requesting a new link invalidates the previous one.
      </p>
      <button
        type="button"
        :disabled="pending"
        class="lore-button-secondary mt-4"
        @click="$emit('resend')"
      >
        {{ pending ? "Sending another link…" : "Resend link" }}
      </button>
    </div>
  </div>
</template>
