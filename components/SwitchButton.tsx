import { switchAction } from "@/app/actions/session";

// Back to the gate, on every screen.
export function SwitchButton() {
  return (
    <form action={switchAction}>
      <button className="btn sm" type="submit">
        Switch
      </button>
    </form>
  );
}
