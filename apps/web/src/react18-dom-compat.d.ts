import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
  }
}
