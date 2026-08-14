<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  workspaceToken: string | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const toast = useToast();
const runtimeConfig = useRuntimeConfig();
const panel = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
let returnFocus: HTMLElement | null = null;
let previousBodyOverflow = "";

const installCommand = computed(
  () =>
    `curl -fsSL ${shellQuote(String(runtimeConfig.public.loreInstallUrl))} | bash`,
);

const claudeConnectCommand = computed(() => {
  const apiUrl = String(runtimeConfig.public.connectorApiUrl).replace(/\/+$/u, "");
  const dashboardUrl = import.meta.client ? window.location.origin : "";
  const dashboardOption =
    dashboardUrl === ""
      ? ""
      : ` --dashboard-url ${shellQuote(dashboardUrl)}`;
  const token = props.workspaceToken ?? "<workspace-token>";
  return `lore connect --url ${shellQuote(apiUrl)}${dashboardOption} --token ${shellQuote(token)} --agent claude`;
});

const agentCommands = computed(() => [
  {
    title: "Install Lore",
    command: installCommand.value,
    description: "Install the standalone CLI on macOS or Linux.",
  },
  {
    title: "Connect Claude Code",
    command: claudeConnectCommand.value,
    description:
      props.workspaceToken === null
        ? "Create a setup command on this page to replace the token placeholder."
        : "Connect only Claude Code using the workspace token you just created.",
  },
  {
    title: "Start Claude Code",
    command: "claude",
    description: "Start Claude normally after Lore is connected.",
  },
  {
    title: "Check Devin access",
    command: "lore devin setup",
    description: "Verify configured Devin credentials and Lore reachability.",
  },
  {
    title: "Start a Devin session",
    command:
      'lore devin start --repo owner/repository --prompt "Fix the failing tests" --max-acu 2',
    description:
      "Replace the repository and prompt. Devin credentials and API polling must be configured.",
  },
]);

const commonCommands = [
  {
    command: "lore status",
    description: "Show the current connection and installed hooks.",
  },
  {
    command: "lore doctor",
    description: "Check configuration, hooks, agent binaries, and API access.",
  },
  {
    command: "lore update",
    description: "Install the latest Lore CLI release.",
  },
  {
    command: "lore connect --help",
    description: "See connection options, including explicit agent selection.",
  },
  {
    command: "lore disconnect",
    description: "Remove Lore-owned hooks and local credentials from this machine.",
  },
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function requestClose(): void {
  emit("close");
}

async function copyCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    toast.show("Command copied.");
  } catch {
    toast.show("Copy failed. Select and copy the command manually.", "error");
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    requestClose();
    return;
  }
  if (event.key !== "Tab" || panel.value === null) {
    return;
  }

  const focusable = Array.from(
    panel.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
  if (focusable.length === 0) {
    event.preventDefault();
    panel.value.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function releasePageLock(): void {
  window.removeEventListener("keydown", handleKeydown);
  document.body.style.overflow = previousBodyOverflow;
}

watch(
  () => props.open,
  async (open) => {
    if (!import.meta.client) {
      return;
    }
    if (open) {
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeydown);
      await nextTick();
      closeButton.value?.focus();
      return;
    }

    releasePageLock();
    returnFocus?.focus();
    returnFocus = null;
  },
);

onBeforeUnmount(() => {
  if (import.meta.client && props.open) {
    releasePageLock();
  }
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-60">
        <button
          type="button"
          class="absolute inset-0 bg-black/70"
          aria-label="Close setup help"
          @click="requestClose"
        />

        <aside
          id="setup-help-drawer"
          ref="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="setup-help-title"
          aria-describedby="setup-help-description"
          tabindex="-1"
          class="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col border-l border-lore-border bg-lore-sidebar shadow-[-16px_0_48px_rgb(0_0_0/0.28)] outline-none"
        >
          <header class="flex items-start justify-between gap-4 border-b border-lore-border px-5 py-5 sm:px-6">
            <div>
              <p class="lore-page-eyebrow">Quick reference</p>
              <h2 id="setup-help-title" class="mt-1.5 text-lg font-semibold text-lore-text">
                Setup help
              </h2>
              <p
                id="setup-help-description"
                class="mt-1 text-sm leading-6 text-lore-text-secondary"
              >
                Connect your agents, verify the installation, and keep useful
                commands close by.
              </p>
            </div>
            <button
              ref="closeButton"
              type="button"
              class="lore-button-ghost min-h-9 shrink-0 px-2.5"
              aria-label="Close setup help"
              @click="requestClose"
            >
              <svg viewBox="0 0 20 20" fill="none" class="size-5" aria-hidden="true">
                <path
                  d="m5 5 10 10M15 5 5 15"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>

          <div class="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <section aria-labelledby="quick-setup-heading">
              <h3 id="quick-setup-heading" class="text-sm font-semibold text-lore-text">
                Quick setup
              </h3>
              <ol class="mt-3 space-y-4">
                <li class="flex gap-3">
                  <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-lore-accent-soft text-xs font-semibold text-lore-accent">1</span>
                  <div>
                    <p class="text-sm font-medium text-lore-text">Create a setup command</p>
                    <p class="mt-0.5 text-xs leading-5 text-lore-text-secondary">
                      Name the machine and choose how long its workspace token
                      should remain valid.
                    </p>
                  </div>
                </li>
                <li class="flex gap-3">
                  <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-lore-accent-soft text-xs font-semibold text-lore-accent">2</span>
                  <div>
                    <p class="text-sm font-medium text-lore-text">Run it in your terminal</p>
                    <p class="mt-0.5 text-xs leading-5 text-lore-text-secondary">
                      Paste the command into a local terminal—not an agent
                      chat. The token is shown only once.
                    </p>
                  </div>
                </li>
                <li class="flex gap-3">
                  <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-lore-accent-soft text-xs font-semibold text-lore-accent">3</span>
                  <div>
                    <p class="text-sm font-medium text-lore-text">Check Doctor</p>
                    <p class="mt-0.5 text-xs leading-5 text-lore-text-secondary">
                      The setup command runs Doctor automatically. Resolve any
                      reported errors before continuing.
                    </p>
                  </div>
                </li>
                <li class="flex gap-3">
                  <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-lore-accent-soft text-xs font-semibold text-lore-accent">4</span>
                  <div>
                    <p class="text-sm font-medium text-lore-text">Use your agent normally</p>
                    <p class="mt-0.5 text-xs leading-5 text-lore-text-secondary">
                      Lore works through installed Codex and Claude hooks. New
                      events appear in Activity.
                    </p>
                  </div>
                </li>
              </ol>
            </section>

            <section class="mt-7 border-t border-lore-border pt-6" aria-labelledby="agent-commands-heading">
              <h3 id="agent-commands-heading" class="text-sm font-semibold text-lore-text">
                Install and run agents
              </h3>
              <div class="mt-3 space-y-3">
                <div
                  v-for="item in agentCommands"
                  :key="item.title"
                  class="rounded-lg border border-lore-border bg-lore-raised p-3"
                >
                  <p class="text-xs font-semibold text-lore-text">
                    {{ item.title }}
                  </p>
                  <div class="mt-2 flex items-start justify-between gap-3 rounded-md bg-lore-sidebar p-2.5">
                    <code class="min-w-0 whitespace-pre-wrap break-all text-xs leading-5 text-lore-text-secondary">
                      {{ item.command }}
                    </code>
                    <button
                      type="button"
                      class="lore-button-ghost min-h-8 shrink-0 px-2.5 py-1 text-xs"
                      @click="copyCommand(item.command)"
                    >
                      Copy
                    </button>
                  </div>
                  <p class="mt-2 text-xs leading-5 text-lore-text-secondary">
                    {{ item.description }}
                  </p>
                </div>
              </div>
            </section>

            <section class="mt-7 border-t border-lore-border pt-6" aria-labelledby="commands-heading">
              <h3 id="commands-heading" class="text-sm font-semibold text-lore-text">
                Common commands
              </h3>
              <div class="mt-3 space-y-2">
                <div
                  v-for="item in commonCommands"
                  :key="item.command"
                  class="rounded-lg border border-lore-border bg-lore-raised p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <code class="break-all text-xs font-semibold text-lore-text">
                      {{ item.command }}
                    </code>
                    <button
                      type="button"
                      class="lore-button-ghost min-h-8 shrink-0 px-2.5 py-1 text-xs"
                      @click="copyCommand(item.command)"
                    >
                      Copy
                    </button>
                  </div>
                  <p class="mt-1 text-xs leading-5 text-lore-text-secondary">
                    {{ item.description }}
                  </p>
                </div>
              </div>
            </section>

            <section class="mt-7 border-t border-lore-border pt-6" aria-labelledby="troubleshooting-heading">
              <h3 id="troubleshooting-heading" class="text-sm font-semibold text-lore-text">
                Troubleshooting
              </h3>
              <div class="mt-3 divide-y divide-lore-border rounded-lg border border-lore-border bg-lore-raised">
                <details class="group p-3">
                  <summary class="lore-focus cursor-pointer rounded text-sm font-medium text-lore-text">
                    The lore command is not found
                  </summary>
                  <p class="mt-2 text-xs leading-5 text-lore-text-secondary">
                    Follow the PATH instruction printed by the installer, then
                    open a new terminal and run <code>lore doctor</code>.
                  </p>
                </details>
                <details class="group p-3">
                  <summary class="lore-focus cursor-pointer rounded text-sm font-medium text-lore-text">
                    Doctor reports an API error
                  </summary>
                  <p class="mt-2 text-xs leading-5 text-lore-text-secondary">
                    Confirm the machine can reach the Lore URL, then create a
                    fresh setup command if the workspace token has expired or
                    was revoked.
                  </p>
                </details>
                <details class="group p-3">
                  <summary class="lore-focus cursor-pointer rounded text-sm font-medium text-lore-text">
                    An agent is not connected
                  </summary>
                  <p class="mt-2 text-xs leading-5 text-lore-text-secondary">
                    Run <code>lore status</code>. If the agent was installed
                    later, create and run a new setup command; reconnecting is
                    safe and does not duplicate hooks.
                  </p>
                </details>
              </div>
            </section>
          </div>

          <footer class="flex flex-col gap-2 border-t border-lore-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <NuxtLink to="/activity" class="lore-button-ghost" @click="requestClose">
              View Activity
            </NuxtLink>
            <a
              href="https://github.com/treadiehq/lore/blob/main/packages/cli/README.md"
              target="_blank"
              rel="noreferrer"
              class="lore-button-secondary"
            >
              Read the full CLI guide
              <span aria-hidden="true">↗</span>
            </a>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>
