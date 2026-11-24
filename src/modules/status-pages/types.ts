export const STATUS_COMPONENT_STATES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'] as const;
export type StatusComponentState = (typeof STATUS_COMPONENT_STATES)[number];
export interface StatusPageRecord { readonly id: string; readonly ownerId: string; readonly slug: string; readonly name: string; readonly summary: string; readonly published: boolean; readonly createdAt: number; readonly updatedAt: number; }
export interface StatusComponentRecord { readonly id: string; readonly pageId: string; readonly name: string; readonly description: string; readonly state: StatusComponentState; readonly position: number; readonly createdAt: number; readonly updatedAt: number; }
export interface StatusComponentChange { readonly id: string; readonly pageId: string; readonly componentId: string; readonly actorId: string; readonly previousState: StatusComponentState; readonly nextState: StatusComponentState; readonly reason: string; readonly createdAt: number; }
export interface CreateStatusPageInput { readonly name: string; readonly slug: string; readonly summary?: string; }
export interface CreateStatusComponentInput { readonly pageId: string; readonly name: string; readonly description?: string; readonly state?: StatusComponentState; }
