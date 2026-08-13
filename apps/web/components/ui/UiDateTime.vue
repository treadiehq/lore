<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { formatDateTime } from "~/utils/memory";

const props = defineProps<{
  value: string;
}>();

const nuxtApp = useNuxtApp();
const useBrowserFormat = ref(import.meta.client && !nuxtApp.isHydrating);

const label = computed(() =>
  useBrowserFormat.value
    ? formatDateTime(props.value)
    : formatDateTime(props.value, {
        locale: "en-US",
        timeZone: "UTC",
      }),
);

onMounted(() => {
  useBrowserFormat.value = true;
});
</script>

<template>
  <time :datetime="value">{{ label }}</time>
</template>
