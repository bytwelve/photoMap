import { useEffect, useMemo, useState } from 'react';
import { CaretRight, Check, Minus } from '@phosphor-icons/react';
import { buildFolderFilterTree, folderPathSetHas, toggleChildFolderFilter, toggleParentFolderFilter } from '../domain';
import type { PhotoRecord } from '../model';

function selectedSubfolderParentPaths(selectedPaths: ReadonlySet<string>): Set<string> {
  const parents = new Set<string>();
  for (const selectedPath of selectedPaths) {
    const separatorIndex = selectedPath.indexOf('/');
    if (separatorIndex > 0) parents.add(selectedPath.slice(0, separatorIndex));
  }
  return parents;
}

export function FolderFilter(props: {
  photos: readonly PhotoRecord[];
  selectedPaths: ReadonlySet<string>;
  onSelectedPathsChange: (selectedPaths: Set<string>) => void;
}): React.JSX.Element {
  const tree = useMemo(() => buildFolderFilterTree(props.photos), [props.photos]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => selectedSubfolderParentPaths(props.selectedPaths),
  );

  useEffect(() => {
    const selectedParents = selectedSubfolderParentPaths(props.selectedPaths);
    if (selectedParents.size === 0) return;
    setExpandedPaths((current) => {
      const next = new Set(current);
      let changed = false;
      for (const parentPath of selectedParents) {
        if (!next.has(parentPath)) {
          next.add(parentPath);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [props.selectedPaths]);

  if (tree.length === 0) {
    return <p className="sidebar-empty">数据源中没有子文件夹</p>;
  }

  return (
    <div className="region-filter-list folder-filter-list">
      {tree.map((folder, index) => {
        const active = folderPathSetHas(props.selectedPaths, folder.path);
        const selectedChildCount = folder.children.filter((child) => folderPathSetHas(props.selectedPaths, child.path)).length;
        const partiallyActive = !active && selectedChildCount > 0;
        const expanded = folderPathSetHas(expandedPaths, folder.path);
        const childListId = `folder-children-${index}`;
        return (
          <div className="province-filter-group folder-filter-group" key={folder.path}>
            <div className={`province-filter-row folder-filter-row${active ? ' active' : ''}${partiallyActive ? ' partial' : ''}`}>
              {folder.children.length > 0 ? (
                <button
                  type="button"
                  className="region-expand-toggle"
                  aria-label={`${expanded ? '收起' : '展开'}${folder.name}下的子文件夹`}
                  aria-expanded={expanded}
                  aria-controls={expanded ? childListId : undefined}
                  onClick={() => setExpandedPaths((current) => toggleParentFolderFilter(current, folder.path))}
                ><CaretRight size={13} aria-hidden="true" /></button>
              ) : <span className="region-expand-spacer" aria-hidden="true" />}
              <button
                type="button"
                className="region-filter-option folder-filter-option"
                data-folder-path={folder.path}
                aria-pressed={active}
                aria-label={partiallyActive ? `${folder.name}，已选择部分子文件夹` : undefined}
                title={folder.path}
                onClick={() => props.onSelectedPathsChange(toggleParentFolderFilter(
                  props.selectedPaths,
                  folder.path,
                ))}
              >
                <span>{folder.name}</span>
                <span className="selection-state" aria-hidden="true">{active ? <Check size={12} weight="bold" /> : partiallyActive ? <Minus size={12} weight="bold" /> : null}</span>
                <small>{folder.photoCount}</small>
              </button>
            </div>
            {expanded && folder.children.length > 0 && (
              <div className="city-filter-list subfolder-filter-list" id={childListId}>
                {folder.children.map((child) => {
                  const childActive = folderPathSetHas(props.selectedPaths, child.path);
                  return (
                    <button
                      type="button"
                      key={child.path}
                      className={`city-filter-option subfolder-filter-option${childActive ? ' active' : ''}`}
                      data-folder-path={child.path}
                      aria-pressed={childActive}
                      title={child.path}
                      onClick={() => props.onSelectedPathsChange(toggleChildFolderFilter(
                        props.selectedPaths,
                        folder.path,
                        child.path,
                      ))}
                    >
                      <span>{child.name}</span>
                      <span className="selection-state" aria-hidden="true">{childActive ? <Check size={12} weight="bold" /> : null}</span>
                      <small>{child.photoCount}</small>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
