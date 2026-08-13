export interface LoreToast {
  id: number;
  message: string;
  tone: "success" | "error";
}

export function useToast() {
  const toasts = useState<LoreToast[]>("lore-toasts", () => []);
  const nextId = useState<number>("lore-toast-id", () => 0);

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function show(
    message: string,
    tone: LoreToast["tone"] = "success",
  ): number {
    nextId.value += 1;
    const id = nextId.value;
    toasts.value = [...toasts.value, { id, message, tone }];
    if (import.meta.client) {
      window.setTimeout(() => dismiss(id), 4_500);
    }
    return id;
  }

  return {
    toasts,
    show,
    dismiss,
  };
}
