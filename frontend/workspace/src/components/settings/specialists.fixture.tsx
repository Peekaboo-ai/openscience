import { Specialists } from "./Specialists"
import type { SpecialistServices } from "./specialists-state"

export function specialistView(services: SpecialistServices) {
  return () => (
    <div data-component="dialog">
      <Specialists services={services} />
    </div>
  )
}
