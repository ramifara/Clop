// The keys of a drag onto Clop, standing in for the Mac's (DropZone.swift, OptimisationUtils.swift): Ctrl shows the preset zones (Control),
// Alt shows the drop zone with `onlyShowDropZoneOnOption` (Option), and Shift at the drop asks for aggressive optimisation (Command).

interface DragLike { preventDefault(): void; dataTransfer: { dropEffect: string } | null }

/**
 * Takes a drag over a Clop drop target, always as a copy. Clop reads the dropped files and never takes them from where they were:
 * Explorer asks for a move while Shift is held, and a target that answered with a move would have Explorer delete the source after
 * the drop. Naming the effect here keeps the key state from choosing it. Call it on dragenter, every dragover and the drop.
 */
export function acceptAsCopy(event: DragLike) {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

/** Shift held at the drop: optimise aggressively (⌘ on macOS). Ctrl is for the preset zones, so it never means aggressive here. */
export const aggressiveDrop = (event: { shiftKey: boolean }) => event.shiftKey;

/** Ctrl held over a drag, which shows the preset zones; only the browser preview reads it from the page, the app hears it from the helper. */
export const zonesKey = (event: { ctrlKey: boolean }) => event.ctrlKey;
