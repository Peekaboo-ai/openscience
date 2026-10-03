import type { JSX } from "solid-js"

export function BrandMark(props: { size: number; class?: string }): JSX.Element {
  return (
    <img
      class={props.class}
      src="/onelab-mark.png"
      width={props.size}
      height={props.size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{
        width: `${props.size}px`,
        height: `${props.size}px`,
        "object-fit": "contain",
        "flex-shrink": 0,
        filter: "var(--logo-filter, none)",
      }}
    />
  )
}
