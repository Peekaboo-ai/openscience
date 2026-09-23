import type { OpenScienceClient } from "@synsci/sdk/v2/client"

type RuntimePrompt = Parameters<OpenScienceClient["runtime"]["prompt"]>[0]

export type ComposerPromptInput = Omit<RuntimePrompt, "requestID" | "message" | "parts" | "messageID"> & {
  agent: string
  messageID: string
  parts: NonNullable<RuntimePrompt["parts"]>
  queued?: boolean
}

/** Negotiate before sending: a failed POST may already have started the run. */
export async function submitComposerPrompt(
  client: OpenScienceClient,
  value: ComposerPromptInput,
  signal?: AbortSignal,
  onSubmit?: () => void,
): Promise<void> {
  const { queued, ...input } = value
  signal?.throwIfAborted()
  if (input.agent !== "research") {
    if (queued) throw new Error("This agent does not support the prompt queue.")
    onSubmit?.()
    await client.session.prompt(input, { throwOnError: true, signal })
    return
  }

  const capabilities = await client.runtime.capabilities(
    { directory: input.directory },
    { throwOnError: false, responseStyle: "fields", signal },
  )
  signal?.throwIfAborted()
  if (capabilities.response?.status === 404) {
    if (queued) throw new Error("Update the connected server to use queued prompts.")
    onSubmit?.()
    await client.session.prompt(input, { throwOnError: true, signal })
    return
  }
  if (capabilities.error !== undefined || !capabilities.response?.ok || !capabilities.data) {
    throw Object.assign(
      new Error("Could not check the server's runtime capabilities.", { cause: capabilities.error }),
      {
        status: capabilities.response?.status,
      },
    )
  }
  if (
    capabilities.data.protocolVersion !== "1.0" ||
    capabilities.data.idempotentPrompts !== true ||
    capabilities.data.richInputs !== true
  ) {
    throw new Error("This server does not support the Research composer runtime protocol. Update the connected server.")
  }

  onSubmit?.()
  if (queued) {
    if (capabilities.data.promptQueue !== true) throw new Error("Update the connected server to use queued prompts.")
    await client.runtime.enqueue({ ...input, requestID: input.messageID }, { throwOnError: true, signal })
    return
  }
  await client.runtime.prompt({ ...input, requestID: input.messageID }, { throwOnError: true, signal })
}
