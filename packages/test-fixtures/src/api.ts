/** Sanitized Data 360 REST response fixtures for adapter and discovery tests. */

export const versionsJson = JSON.stringify([
  { label: "Winter '26", version: '65.0', url: '/services/data/v65.0' },
  { label: "Summer '25", version: '64.0', url: '/services/data/v64.0' },
]);

export const versionsWrappedJson = JSON.stringify({
  result: [{ label: "Spring '26", version: 66, url: '/services/data/v66.0' }],
});

export const dataSpacesJson = JSON.stringify({
  records: [
    { id: '0Sp000000000001', apiName: 'default', label: 'Default Space', description: 'Primary data space', isDefault: true },
    { id: '0Sp000000000002', name: 'sales_space', label: 'Sales Space' },
  ],
});

export const dlosJson = JSON.stringify({
  records: [
    {
      name: 'Account_DLO__dll',
      label: 'Account DLO',
      category: 'Profile',
      dataSpace: 'default',
      sourceName: 'Salesforce CRM',
      fields: [
        { apiName: 'Id', label: 'Id', dataType: 'String', isPrimaryKey: true, isNullable: false },
        { name: 'Name', displayName: 'Account Name', type: 'String', required: true },
      ],
    },
    {
      apiName: 'Order_DLO__dll',
      label: 'Order DLO',
      dataSpace: 'sales_space',
      fieldDefinitions: [{ fieldName: 'Id', fieldType: 'String', primaryKey: true }],
    },
  ],
});

export const dmosJson = JSON.stringify({
  records: [
    {
      apiName: 'Account_DMO__dlm',
      label: 'Account DMO',
      category: 'Profile',
      dataSpace: 'default',
      isCustom: true,
      fields: [
        { apiName: 'Id', dataType: 'String', isPrimaryKey: true, isNullable: false },
        { apiName: 'Name', dataType: 'String' },
      ],
      relationships: [
        { targetObject: 'Contact_DMO__dlm', joinField: 'AccountId', cardinality: '1:N' },
      ],
    },
    {
      apiName: 'Contact_DMO__dlm',
      label: 'Contact DMO',
      dataSpace: 'default',
      fields: [
        { apiName: 'Id', dataType: 'String', isPrimaryKey: true },
        { apiName: 'AccountId', dataType: 'String' },
      ],
    },
    {
      apiName: 'Order_DMO__dlm',
      label: 'Order DMO',
      dataSpace: 'sales_space',
      fields: [{ apiName: 'AccountId', dataType: 'String' }],
    },
  ],
});

/** Live v68 per-DMO relationship shape, including source status. */
export const dmoRelationshipsJson = JSON.stringify({
  currentPageUrl: '/services/data/v68.0/ssot/data-model-objects/Account_DMO__dlm/relationships?limit=500',
  relationships: [{
    cardinality: 'ManyToOne',
    creationType: 'Standard',
    id: '0geDEMO000000001AAA',
    name: 'Account_ContactId_map_Contact_Id_N_1',
    owner: 'DataCloud',
    sourceField: { label: 'Contact', name: 'ContactId', type: 'MktDataModelField' },
    sourceObject: { keyQualifierField: null, label: 'Account', name: 'Account_DMO__dlm' },
    status: 'INACTIVE',
    targetField: { label: 'Id', name: 'Id', type: 'MktDataModelField' },
    targetObject: { keyQualifierField: null, label: 'Contact', name: 'Contact_DMO__dlm' },
  }],
  totalSize: 1,
});

export const mappingsJson = JSON.stringify({
  records: [
    {
      apiName: 'Account_Map',
      sourceObject: 'Account_DLO__dll',
      targetObject: 'Account_DMO__dlm',
      fieldMappings: [
        { sourceField: 'Id', targetField: 'Id' },
        { source: 'Name', target: 'Name', transformation: 'trim' },
      ],
    },
    { source: 'Order_DLO__dll', target: 'Order_DMO__dlm' },
  ],
});

export const dataStreamsJson = JSON.stringify({
  records: [
    {
      apiName: 'Account_Stream',
      label: 'Account Stream',
      sourceConnector: 'Salesforce CRM',
      targetDlo: 'Account_DLO__dll',
      status: 'Running',
      refreshRate: '15m',
    },
  ],
});

export const dataTransformsJson = JSON.stringify({
  records: [
    { apiName: 'Account_Transform', label: 'Account Transform', status: 'Active', description: 'Normalizes account names' },
  ],
});

export const transformDetailJson = JSON.stringify({
  result: {
    id: '0TfTEST000000001AAA',
    apiName: 'Account_Transform',
    label: 'Account Transform',
    type: 'Batch',
    status: 'Active',
    lastRunStatus: 'Success',
    lastRunAt: '2026-11-17T01:30:00.000Z',
    inputObjects: ['Account_DLO__dll', 'Order_DLO__dll'],
    targetObjects: ['Account_DMO__dlm'],
    scheduleSummary: 'Daily at 02:00 UTC',
    transformDefinition: { nodes: [{ name: 'Clean Names', type: 'transform' }] },
    dataSpace: 'default',
    createdDate: '2026-09-01T09:00:00.000Z',
    LastModifiedDate: '2026-11-16T14:20:00.000Z',
    ownerName: 'architect@example.invalid',
  },
});

export const transformRunHistoryJson = JSON.stringify({
  records: [
    {
      runId: 'run-1',
      runStatus: 'Success',
      startTime: '2026-11-17T02:00:04.000Z',
      endTime: '2026-11-17T02:03:19.000Z',
      processedRecords: 12840,
      message: 'Completed without errors.',
    },
    {
      runId: 'run-2',
      runStatus: 'Failure',
      startTime: '2026-11-16T02:00:02.000Z',
      endTime: '2026-11-16T02:01:11.000Z',
      processedRecords: 412,
      errorMessage: 'Source object was temporarily unavailable.',
    },
  ],
});

export const transformRunHistoryPage1Json = JSON.stringify({
  records: [{ runId: 'run-page-1', status: 'Success' }],
  nextToken: 'transform-page-2',
});

export const transformRunHistoryPage2Json = JSON.stringify({
  records: [{ runId: 'run-page-2', status: 'Failure' }],
});

export const transformScheduleJson = JSON.stringify({
  result: {
    frequency: 'Daily',
    timeZone: 'UTC',
    nextRunAt: '2026-11-18T02:00:00.000Z',
    lastRunAt: '2026-11-17T02:00:04.000Z',
    enabled: true,
  },
});

export const transformScheduleEmptyJson = JSON.stringify({ records: [] });

export const paginatedDlosPage1Json = JSON.stringify({
  records: [{ apiName: 'Page1_DLO__dll', fields: [] }],
  nextToken: 'page-2-token',
});

export const paginatedDlosPage2Json = JSON.stringify({
  records: [{ apiName: 'Page2_DLO__dll', fields: [] }],
});

export const dmosOffsetPage2Json = JSON.stringify({
  dataModelObject: [{ name: 'Page2_DMO__dlm', dataSpaceName: 'default', isEnabled: true, fields: [] }],
});

export const malformedApiJson = 'this is not json';

/** Salesforce answer for a valid DMO developer name that has no object-source-target maps. */
export const mappingNotFoundOutput = 'Salesforce CLI command failed: NOT_FOUND: Object Source Target Map not found for the given Target Object Dev Name : Account_DMO__dlm  ,';

export const forbiddenRestOutput = 'ERROR running api request rest: status code 403 Forbidden';

export const unsupportedRestOutput = 'ERROR running api request rest: (404) Not Found';
