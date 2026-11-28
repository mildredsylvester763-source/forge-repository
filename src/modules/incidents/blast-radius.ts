import { AppError } from '../../kernel/errors.ts';
import { planDeploymentDependencies, type DeploymentDependencyNode } from '../deployments/dependency-graph.ts';

export interface CustomerServiceMapping {
  readonly customerId: string;
  readonly serviceIds: readonly string[];
}

export interface ServiceRegionMapping {
  readonly serviceId: string;
  readonly regionId: string;
}

export interface IncidentBlastRadiusInput {
  readonly incidentId: string;
  readonly services: readonly DeploymentDependencyNode[];
  readonly affectedServiceIds: readonly string[];
  readonly customerServiceMappings: readonly CustomerServiceMapping[];
  readonly serviceRegions: readonly ServiceRegionMapping[];
}

export interface IncidentBlastRadiusResult {
  readonly incidentId: string;
  readonly method: 'dependency-reverse-closure-v1';
  readonly inventorySource: 'request-supplied';
  readonly computedAt: number;
  readonly directAffectedServiceIds: readonly string[];
  readonly downstreamAffectedServiceIds: readonly string[];
  readonly affectedServiceIds: readonly string[];
  readonly affectedCustomerIds: readonly string[];
  readonly affectedRegionIds: readonly string[];
  readonly coverage: {
    readonly customerMappedServiceIds: readonly string[];
    readonly customerUnmappedServiceIds: readonly string[];
    readonly regionMappedServiceIds: readonly string[];
    readonly regionUnmappedServiceIds: readonly string[];
  };
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CUSTOMERS = 5_000;
const MAX_REGION_MAPPINGS = 4_096;
const MAX_SERVICE_MAPPINGS_PER_CUSTOMER = 256;

function invalid(reason: string): never {
  throw new AppError(400, 'incident_blast_radius_invalid', 'Blast-radius input is invalid.', {
    details: { reason },
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('expected_object');
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(context + '_unknown_field:' + key);
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid(field + '_invalid');
  return value;
}

function identifierList(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) invalid(field + '_invalid_length');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = identifier(raw, field);
    if (seen.has(id)) invalid(field + '_duplicate:' + id);
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Parse and validate the owner-supplied service/customer/region inventory.
 * The repository has no canonical customer or deployment-region registry, so this
 * API never invents or silently infers those relationships.
 */
export function parseIncidentBlastRadiusInput(value: unknown): IncidentBlastRadiusInput {
  const body = record(value);
  exactFields(body, ['incidentId', 'services', 'affectedServiceIds', 'customerServiceMappings', 'serviceRegions'], 'body');

  const incidentId = identifier(body.incidentId, 'incidentId');
  const graphResult = planDeploymentDependencies(body.services);
  if (!graphResult.ok) invalid('service_graph:' + graphResult.reason);
  const services = body.services as DeploymentDependencyNode[];
  const serviceIds = new Set(services.map((service) => service.id));

  const affectedServiceIds = identifierList(body.affectedServiceIds, 'affectedServiceIds', 256);
  for (const id of affectedServiceIds) {
    if (!serviceIds.has(id)) invalid('affected_service_unknown:' + id);
  }

  if (!Array.isArray(body.customerServiceMappings) || body.customerServiceMappings.length > MAX_CUSTOMERS) {
    invalid('customer_mappings_invalid_length');
  }
  const customerServiceMappings: CustomerServiceMapping[] = [];
  const seenCustomers = new Set<string>();
  for (const raw of body.customerServiceMappings) {
    const mapping = record(raw);
    exactFields(mapping, ['customerId', 'serviceIds'], 'customer_mapping');
    const customerId = identifier(mapping.customerId, 'customerId');
    if (seenCustomers.has(customerId)) invalid('customer_mapping_duplicate:' + customerId);
    seenCustomers.add(customerId);
    const mappedServices = identifierList(mapping.serviceIds, 'customerServiceIds', MAX_SERVICE_MAPPINGS_PER_CUSTOMER);
    for (const serviceId of mappedServices) {
      if (!serviceIds.has(serviceId)) invalid('customer_service_unknown:' + serviceId);
    }
    customerServiceMappings.push({ customerId, serviceIds: mappedServices });
  }

  if (!Array.isArray(body.serviceRegions) || body.serviceRegions.length > MAX_REGION_MAPPINGS) {
    invalid('service_regions_invalid_length');
  }
  const serviceRegions: ServiceRegionMapping[] = [];
  const seenRegionPairs = new Set<string>();
  for (const raw of body.serviceRegions) {
    const mapping = record(raw);
    exactFields(mapping, ['serviceId', 'regionId'], 'service_region');
    const serviceId = identifier(mapping.serviceId, 'serviceId');
    const regionId = identifier(mapping.regionId, 'regionId');
    if (!serviceIds.has(serviceId)) invalid('region_service_unknown:' + serviceId);
    const pair = serviceId + '\u0000' + regionId;
    if (seenRegionPairs.has(pair)) invalid('service_region_duplicate:' + serviceId + ':' + regionId);
    seenRegionPairs.add(pair);
    serviceRegions.push({ serviceId, regionId });
  }

  return { incidentId, services, affectedServiceIds, customerServiceMappings, serviceRegions };
}

/** Compute transitive dependents of the directly affected services. */
export function calculateIncidentBlastRadius(
  input: IncidentBlastRadiusInput,
  computedAt: number,
): IncidentBlastRadiusResult {
  const dependents = new Map<string, Set<string>>();
  for (const service of input.services) dependents.set(service.id, new Set());
  for (const service of input.services) {
    for (const dependency of service.dependsOn ?? []) dependents.get(dependency)?.add(service.id);
  }

  const direct = [...input.affectedServiceIds].sort();
  const directSet = new Set(direct);
  const affected = new Set(direct);
  const queue = [...direct];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const dependent of [...(dependents.get(current) ?? [])].sort()) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  const affectedServices = [...affected].sort();
  const customerMapped = new Set<string>();
  const affectedCustomers = new Set<string>();
  for (const mapping of input.customerServiceMappings) {
    let intersects = false;
    for (const serviceId of mapping.serviceIds) {
      customerMapped.add(serviceId);
      if (affected.has(serviceId)) intersects = true;
    }
    if (intersects) affectedCustomers.add(mapping.customerId);
  }

  const regionMapped = new Set<string>();
  const affectedRegions = new Set<string>();
  for (const mapping of input.serviceRegions) {
    regionMapped.add(mapping.serviceId);
    if (affected.has(mapping.serviceId)) affectedRegions.add(mapping.regionId);
  }

  return {
    incidentId: input.incidentId,
    method: 'dependency-reverse-closure-v1',
    inventorySource: 'request-supplied',
    computedAt,
    directAffectedServiceIds: direct,
    downstreamAffectedServiceIds: affectedServices.filter((id) => !directSet.has(id)),
    affectedServiceIds: affectedServices,
    affectedCustomerIds: [...affectedCustomers].sort(),
    affectedRegionIds: [...affectedRegions].sort(),
    coverage: {
      customerMappedServiceIds: affectedServices.filter((id) => customerMapped.has(id)),
      customerUnmappedServiceIds: affectedServices.filter((id) => !customerMapped.has(id)),
      regionMappedServiceIds: affectedServices.filter((id) => regionMapped.has(id)),
      regionUnmappedServiceIds: affectedServices.filter((id) => !regionMapped.has(id)),
    },
  };
}
