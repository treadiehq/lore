<script setup lang="ts">
import type { MemoryCategory, MemoryScope } from "@lore-co/sdk";
import { ref } from "vue";
import {
  categoryLabel,
  errorMessage,
  memoryCategories,
} from "~/utils/memory";

definePageMeta({ middleware: "auth" });
useHead({ title: "New learning" });

const client = useSharedMemoryClient();
const toast = useToast();
const content = ref("");
const category = ref<MemoryCategory>("other");
const organization = ref("");
const project = ref("");
const repo = ref("");
const path = ref("");
const component = ref("");
const pending = ref(false);
const formError = ref("");

function scope(): MemoryScope {
  return {
    ...(organization.value.trim() ? { organization: organization.value.trim() } : {}),
    ...(project.value.trim() ? { project: project.value.trim() } : {}),
    ...(repo.value.trim() ? { repo: repo.value.trim() } : {}),
    ...(path.value.trim() ? { path: path.value.trim() } : {}),
    ...(component.value.trim() ? { component: component.value.trim() } : {}),
  };
}

async function createLearning(): Promise<void> {
  formError.value = "";
  const statement = content.value.trim();
  if (!statement) {
    formError.value = "Enter the durable statement this workspace should remember.";
    return;
  }

  pending.value = true;
  try {
    const response = await client.createLearning({
      content: statement,
      category: category.value,
      scope: scope(),
      source: {
        agent: "dashboard",
        rawText: statement,
      },
    });
    toast.show("Learning created.");
    await navigateTo(`/memories/${response.memory.id}`);
  } catch (caught) {
    formError.value = errorMessage(caught);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <NuxtLink to="/memories" class="lore-link text-sm">
      ← Back to learnings
    </NuxtLink>

    <header class="mt-6 border-b border-lore-border pb-5">
      <p class="lore-page-eyebrow">
        Knowledge base
      </p>
      <h1 class="lore-page-title mt-1.5">
        New learning
      </h1>
      <p class="lore-page-description mt-1.5">
        Add a durable statement manually. Connected tools will receive it when
        the scope matches their work.
      </p>
    </header>

    <form class="mt-6 space-y-6" @submit.prevent="createLearning">
      <section class="rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6">
        <UiField
          label="Statement"
          for="new-learning-content"
          hint="Write a direct rule or fact that should remain true across sessions."
          required
        >
          <textarea
            id="new-learning-content"
            v-model="content"
            rows="6"
            required
            class="lore-textarea resize-y"
            placeholder="Use AccountStore for account persistence. RepositoryFactory is deprecated."
          />
        </UiField>

        <UiField label="Category" for="new-learning-category" class="mt-5">
          <select
            id="new-learning-category"
            v-model="category"
            class="lore-select"
          >
            <option
              v-for="item in memoryCategories"
              :key="item"
              :value="item"
            >
              {{ categoryLabel(item) }}
            </option>
          </select>
        </UiField>
      </section>

      <section class="rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6">
        <h2 class="text-sm font-semibold text-lore-text">Scope</h2>
        <p class="mt-1 text-xs leading-5 text-lore-text-muted">
          Leave every field empty to make this available workspace-wide.
        </p>
        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <UiField label="Organization" for="new-learning-organization">
            <input id="new-learning-organization" v-model="organization" class="lore-input">
          </UiField>
          <UiField label="Project" for="new-learning-project">
            <input id="new-learning-project" v-model="project" class="lore-input">
          </UiField>
          <UiField label="Repository" for="new-learning-repo" hint="owner/repository">
            <input id="new-learning-repo" v-model="repo" class="lore-input" placeholder="acme/platform">
          </UiField>
          <UiField label="Path" for="new-learning-path" hint="Directory or file prefix">
            <input id="new-learning-path" v-model="path" class="lore-input" placeholder="src/accounts">
          </UiField>
          <UiField label="Component" for="new-learning-component">
            <input id="new-learning-component" v-model="component" class="lore-input" placeholder="accounts">
          </UiField>
        </div>
      </section>

      <UiInlineAlert
        v-if="formError"
        title="Learning wasn’t created"
        :message="formError"
      />

      <div class="flex justify-end gap-2 border-t border-lore-border pt-5">
        <NuxtLink to="/memories" class="lore-button-ghost">Cancel</NuxtLink>
        <button type="submit" class="lore-button-primary" :disabled="pending">
          {{ pending ? "Creating…" : "Create learning" }}
        </button>
      </div>
    </form>
  </div>
</template>
