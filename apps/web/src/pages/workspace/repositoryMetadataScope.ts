type RepositoryWithId = {
  id: string;
};

export function shouldIncludeRepositoryInMetadataScope(params: {
  repositoryId: string;
  selectedRepositoryId: string | null;
  expandedByRepo: Record<string, boolean>;
}): boolean {
  const { repositoryId, selectedRepositoryId, expandedByRepo } = params;
  return selectedRepositoryId === repositoryId || expandedByRepo[repositoryId] === true;
}

export function filterRepositoriesForMetadataScope<TRepository extends RepositoryWithId>(params: {
  repositories: TRepository[];
  selectedRepositoryId: string | null;
  expandedByRepo: Record<string, boolean>;
}): TRepository[] {
  const { repositories, selectedRepositoryId, expandedByRepo } = params;
  return repositories.filter((repository) => shouldIncludeRepositoryInMetadataScope({
    repositoryId: repository.id,
    selectedRepositoryId,
    expandedByRepo,
  }));
}
