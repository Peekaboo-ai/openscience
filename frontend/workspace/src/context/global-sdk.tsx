import { createOpenScienceClient, type Event } from "@synsci/sdk/v2/client"
import { createSimpleContext } from "@synsci/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { serverEvents } from "./server-events"
import { createGlobalEventBuffer } from "./global-event-buffer"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const platform = usePlatform()

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    const queue = createGlobalEventBuffer()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    let disposed = false

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (disposed) return
      if (queue.length === 0) return

      last = Date.now()
      batch(() => queue.flush((event) => emitter.emit(event.directory, event.payload)))
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    const unsubscribe = serverEvents.subscribe(server.url, platform.fetch ?? fetch, (event) => {
      const directory = event.directory ?? "global"
      const payload = event.payload
      queue.push(directory, payload)
      schedule()
    })

    // Deliver what is already queued while the owner is still alive; anything
    // that arrives after this point must not be emitted into a disposed tree.
    onCleanup(() => {
      flush()
      disposed = true
      unsubscribe()
    })

    const sdk = createOpenScienceClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter }
  },
})
