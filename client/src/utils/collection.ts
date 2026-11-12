import { InfiniteData, QueryClient } from '@tanstack/react-query';

export const addData = <TCollection, TData>(
  data: InfiniteData<TCollection>,
  collectionName: string,
  newData: TData,
  findIndex: (page: TCollection) => number,
) => {
  const dataJson = JSON.parse(JSON.stringify(data)) as InfiniteData<TCollection>;
  const { pageIndex, index } = findPage<TCollection>(data, findIndex);

  if (pageIndex !== -1 && index !== -1) {
    return updateData(data, collectionName, newData, findIndex);
  }
  dataJson.pages[0][collectionName].unshift({
    ...newData,
    updatedAt: new Date().toISOString(),
  });

  return dataJson;
};

export const getRecordByProperty = <TCollection, TData>(
  data: InfiniteData<TCollection>,
  collectionName: string,
  findProperty: (item: TData) => boolean,
): TData | undefined => {
  // Find the page and the index of the record in that page
  const { pageIndex, index } = findPage<TCollection>(data, (page) =>
    page[collectionName].findIndex(findProperty),
  );

  // If found, return the record
  if (pageIndex !== -1 && index !== -1) {
    return data.pages[pageIndex][collectionName][index];
  }

  // Return undefined if the record is not found
  return undefined;
};

export function findPage<TData>(data: InfiniteData<TData>, findIndex: (page: TData) => number) {
  for (let pageIndex = 0; pageIndex < data.pages.length; pageIndex++) {
    const page = data.pages[pageIndex];
    const index = findIndex(page);
    if (index !== -1) {
      return { pageIndex, index };
    }
  }
  return { pageIndex: -1, index: -1 }; // Not found
}

export const updateData = <TCollection, TData>(
  data: InfiniteData<TCollection>,
  collectionName: string,
  updatedData: TData,
  findIndex: (page: TCollection) => number,
) => {
  const newData = JSON.parse(JSON.stringify(data)) as InfiniteData<TCollection>;
  const { pageIndex, index } = findPage<TCollection>(data, findIndex);

  if (pageIndex !== -1 && index !== -1) {
    // Remove the data from its current position
    newData.pages[pageIndex][collectionName].splice(index, 1);
    // Add the updated data to the top of the first page
    newData.pages[0][collectionName].unshift({
      ...updatedData,
      updatedAt: new Date().toISOString(),
    });
  }

  return newData;
};

export const deleteData = <TCollection, TData>(
  data: TData,
  collectionName: string,
  findIndex: (page: TCollection) => number,
): TData => {
  const newData = JSON.parse(JSON.stringify(data));
  const { pageIndex, index } = findPage<TCollection>(newData, findIndex);

  if (pageIndex !== -1 && index !== -1) {
    // Delete the data from its current page
    newData.pages[pageIndex][collectionName].splice(index, 1);
  }
  return newData;
};

export const updateFields = <TCollection, TData>(
  data: InfiniteData<TCollection>,
  updatedItem: Partial<TData>,
  collectionName: string,
  identifierField: keyof TData,
  callback?: (newItem: TData) => void,
): InfiniteData<TCollection> => {
  const newData = JSON.parse(JSON.stringify(data)) as InfiniteData<TCollection>;
  const { pageIndex, index } = findPage<TCollection>(newData, (page) =>
    page[collectionName].findIndex(
      (item: TData) => item[identifierField] === updatedItem[identifierField],
    ),
  );

  if (pageIndex !== -1 && index !== -1) {
    const deleted = newData.pages[pageIndex][collectionName].splice(index, 1);
    const oldItem = deleted[0];
    const newItem = {
      ...oldItem,
      ...updatedItem,
      updatedAt: new Date().toISOString(),
    };
    if (callback) {
      callback(newItem);
    }
    newData.pages[0][collectionName].unshift(newItem);
  }

  return newData;
};

export const updateFieldsInPlace = <TCollection, TData>(
  data: InfiniteData<TCollection>,
  updatedItem: Partial<TData>,
  collectionName: string,
  identifierField: keyof TData,
): InfiniteData<TCollection> => {
  const identifierValue = updatedItem[identifierField];
  if (identifierValue == null) {
    return data;
  }

  const { pageIndex, index } = findPage<TCollection>(data, (page) =>
    page[collectionName].findIndex((item: TData) => item[identifierField] === identifierValue),
  );

  if (pageIndex === -1 || index === -1) {
    return data;
  }

  const oldItem = data.pages[pageIndex][collectionName][index];
  const newItem = { ...oldItem, ...updatedItem };

  const newCollection = [...data.pages[pageIndex][collectionName]];
  newCollection[index] = newItem;

  const newPage = { ...data.pages[pageIndex], [collectionName]: newCollection };
  const newPages = [...data.pages];
  newPages[pageIndex] = newPage;

  return { ...data, pages: newPages };
};

type UpdateCacheListOptions<TData> = {
  queryClient: QueryClient;
  queryKey: unknown[];
  searchProperty: keyof TData;
  updateData: Partial<TData>;
  searchValue: unknown;
};

export function updateCacheList<TData>({
  queryClient,
  queryKey,
  searchProperty,
  updateData,
  searchValue,
}: UpdateCacheListOptions<TData>) {
  queryClient.setQueryData<TData[]>(queryKey, (oldData) => {
    if (!oldData) {
      return oldData;
    }

    return oldData.map((item) =>
      item[searchProperty] === searchValue ? { ...item, ...updateData } : item,
    );
  });
}

export function addToCacheList<TData>(
  queryClient: QueryClient,
  queryKey: unknown[],
  newItem: TData,
) {
  queryClient.setQueryData<TData[]>(queryKey, (oldData) => {
    if (!oldData) {
      return [newItem];
    }
    return [...oldData, newItem];
  });
}

export function removeFromCacheList<TData>(
  queryClient: QueryClient,
  queryKey: unknown[],
  searchProperty: keyof TData,
  searchValue: unknown,
) {
  queryClient.setQueryData<TData[]>(queryKey, (oldData) => {
    if (!oldData) {
      return oldData;
    }
    return oldData.filter((item) => item[searchProperty] !== searchValue);
  });
}
