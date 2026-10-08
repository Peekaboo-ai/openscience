import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

type Item = { id: string }

export function createQueueDrag(props: {
  items: () => readonly Item[]
  revision: () => number | undefined
  session: () => unknown
  disabled: () => boolean
  move: (id: string, before: string | null, revision: number) => Promise<unknown>
}) {
  const [state, setState] = createStore({
    id: "",
    active: false,
    inside: false,
    before: null as string | null,
    offset: 0,
  })
  let list: HTMLOListElement | undefined
  let frame: number | undefined
  let tracking:
    | {
        id: string
        handle: HTMLButtonElement
        row: HTMLElement
        pointer: number
        start: number
        scroll: number
        x: number
        y: number
        revision: number
        session: unknown
      }
    | undefined

  const cancel = () => {
    const previous = tracking
    tracking = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    if (previous?.handle.hasPointerCapture?.(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer)
    setState({ id: "", active: false, inside: false, before: null, offset: 0 })
  }
  const valid = () =>
    !!tracking &&
    !props.disabled() &&
    tracking.revision === props.revision() &&
    tracking.session === props.session() &&
    props.items().some((item) => item.id === tracking!.id)

  createEffect(() => {
    props.revision()
    props.session()
    props.disabled()
    props.items()
    // 轮询发现队列变化或切换会话时取消手势，不能把旧排序写到新的队列版本。
    if (tracking && !valid()) cancel()
  })

  const locate = () => {
    if (!tracking || !list) return
    const bounds = list.getBoundingClientRect()
    const inside =
      tracking.x >= bounds.left &&
      tracking.x <= bounds.right &&
      tracking.y >= bounds.top - 24 &&
      tracking.y <= bounds.bottom + 24
    const rows = [...list.querySelectorAll<HTMLElement>("[data-queue-id]")]
    const before = rows.find((row) => {
      if (row.dataset.queueId === tracking!.id) return false
      const rect = row.getBoundingClientRect()
      return tracking!.y < rect.top + rect.height / 2
    })?.dataset.queueId
    const row = tracking.row.getBoundingClientRect()
    const top = row.top - state.offset
    const offset = Math.max(
      bounds.top - top,
      Math.min(bounds.bottom - top - row.height, tracking.y - tracking.start + list.scrollTop - tracking.scroll),
    )
    setState({ inside, before: before ?? null, offset })
  }
  let lastFrame = 0
  const animate = (time: number) => {
    if (!tracking || !list || !state.active) return
    if (!valid()) return cancel()
    const elapsed = Math.min(time - lastFrame, 32)
    lastFrame = time
    const rect = list.getBoundingClientRect()
    // 持续靠近上下边缘即可滚动长队列；按时间计算速度，避免高刷新率屏幕滚动过快。
    if (
      tracking.x >= rect.left &&
      tracking.x <= rect.right &&
      tracking.y >= rect.top - 24 &&
      tracking.y <= rect.bottom + 24
    ) {
      const edge = 28
      const direction = tracking.y < rect.top + edge ? -1 : tracking.y > rect.bottom - edge ? 1 : 0
      list.scrollTop += direction * elapsed * 0.45
    }
    locate()
    frame = requestAnimationFrame(animate)
  }

  const finish = (event: PointerEvent) => {
    if (!tracking || event.pointerId !== tracking.pointer) return
    tracking.x = event.clientX
    tracking.y = event.clientY
    locate()
    const current = tracking
    const next = props.items()[props.items().findIndex((item) => item.id === current.id) + 1]?.id ?? null
    const before = state.before
    const submit = valid() && state.active && state.inside && next !== before
    cancel()
    if (submit) void props.move(current.id, before, current.revision)
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !tracking) return
    // 拖动中的 Escape 只撤销排序，不能冒泡成停止当前科研任务。
    event.preventDefault()
    event.stopImmediatePropagation()
    cancel()
  }
  document.addEventListener("keydown", escape, true)
  window.addEventListener("blur", cancel)
  onCleanup(() => {
    cancel()
    document.removeEventListener("keydown", escape, true)
    window.removeEventListener("blur", cancel)
  })

  return {
    state,
    ref: (element: HTMLOListElement) => (list = element),
    cancel,
    start(event: PointerEvent & { currentTarget: HTMLButtonElement }, id: string) {
      if (props.disabled() || props.items().length < 2 || event.button !== 0 || event.isPrimary === false) return
      const revision = props.revision()
      const row = event.currentTarget.closest<HTMLElement>("[data-queue-id]")
      if (revision === undefined || !row || !list) return
      cancel()
      tracking = {
        id,
        handle: event.currentTarget,
        row,
        pointer: event.pointerId,
        start: event.clientY,
        scroll: list.scrollTop,
        x: event.clientX,
        y: event.clientY,
        revision,
        session: props.session(),
      }
      event.preventDefault()
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setState("id", id)
    },
    update(event: PointerEvent) {
      if (!tracking || event.pointerId !== tracking.pointer) return
      tracking.x = event.clientX
      tracking.y = event.clientY
      if (!state.active && Math.abs(event.clientY - tracking.start) >= 6) {
        setState("active", true)
        lastFrame = performance.now()
        frame = requestAnimationFrame(animate)
      }
      if (state.active) locate()
    },
    finish,
    key(event: KeyboardEvent, id: string) {
      if (props.disabled() || tracking || !["ArrowUp", "ArrowDown"].includes(event.key)) return
      event.preventDefault()
      const items = props.items()
      const index = items.findIndex((item) => item.id === id)
      const revision = props.revision()
      if (revision === undefined || index < 0) return
      if (event.key === "ArrowUp" && index > 0) void props.move(id, items[index - 1]!.id, revision)
      if (event.key === "ArrowDown" && index < items.length - 1)
        void props.move(id, items[index + 2]?.id ?? null, revision)
    },
  }
}
