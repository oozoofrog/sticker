import type {
  HistoryField,
  HistoryFieldChange,
} from "../../../server/contracts/history.js";
import type { Version } from "../../../server/types.js";
import { priorityNames, statusNames } from "../../format.js";
export const historyFieldNames: Record<HistoryField, string> = {
  title: "제목",
  description: "본문",
  status: "상태",
  priority: "우선순위",
  assignee: "담당자",
  labels: "라벨",
  targetVersionId: "목표 버전",
  foundVersionId: "발견 버전",
  fixedVersionId: "수정 버전",
};
function display(
  field: HistoryField,
  value: HistoryFieldChange["before"],
  versions: Version[],
) {
  if (value === null) return "미지정";
  if (Array.isArray(value))
    return value.length ? JSON.stringify(value, null, 2) : "없음";
  if (field.endsWith("VersionId"))
    return (
      versions.find((version) => version.id === value)?.name ??
      `사용 불가 · ${value}`
    );
  const names: Record<string, string> =
    field === "status"
      ? statusNames
      : field === "priority"
        ? priorityNames
        : {};
  return Object.hasOwn(names, value) ? names[value] : value || "빈 값";
}
export function FieldDiff({
  changes,
  versions,
  beforeLabel = "이전",
  afterLabel = "이후",
  selected,
  onSelect,
  disabled = false,
}: {
  changes: readonly HistoryFieldChange[];
  versions: Version[];
  beforeLabel?: string;
  afterLabel?: string;
  selected?: readonly HistoryField[];
  onSelect?: (field: HistoryField, checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="history-field-list">
      {changes.map((change) => (
        <section
          className="history-field"
          key={change.field}
          aria-label={historyFieldNames[change.field]}
        >
          <h3>
            {onSelect && (
              <input
                type="checkbox"
                aria-label={`${historyFieldNames[change.field]} 복원 선택`}
                checked={selected?.includes(change.field) ?? false}
                disabled={disabled}
                onChange={(event) => {
                  onSelect(change.field, event.target.checked);
                }}
              />
            )}
            {historyFieldNames[change.field]}
          </h3>
          <div className="history-values">
            <div>
              <h4>{beforeLabel}</h4>
              <pre>{display(change.field, change.before, versions)}</pre>
            </div>
            <div>
              <h4>{afterLabel}</h4>
              <pre>{display(change.field, change.after, versions)}</pre>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
