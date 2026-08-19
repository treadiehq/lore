<script setup lang="ts">
import type { MemoryStatus } from "@lore-co/sdk";
import { statusLabel } from "~/utils/memory";

const props = defineProps<{
  status: MemoryStatus;
}>();

const statusClass: Record<MemoryStatus, string> = {
  active: "border-lore-success/30 bg-lore-success-soft text-lore-success",
  proposed: "border-lore-accent/30 bg-lore-accent-soft text-lore-accent",
  suppressed: "border-lore-danger/30 bg-lore-danger-soft text-lore-danger",
  superseded: "border-lore-warning/30 bg-lore-warning-soft text-lore-warning",
  deleted: "border-lore-border bg-lore-raised text-lore-text-muted",
};
</script>

<template>
  <span
    class="inline-flex w-fit items-center rounded-md border px-2 py-0.5 text-xs font-medium"
    :class="statusClass[props.status]"
  >
    {{ statusLabel(props.status) }}
  </span>
</template>
