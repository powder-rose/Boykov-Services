import { initials } from "../identity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, ShieldCheck, UsersRound, X } from "lucide-react";
import { api, errorText } from "../api";
import { Empty, Loading, Notice, PageHead } from "../components/Common";
import "./Accounts.css";

type Account = {
  id: string;
  login: string;
  name: string;
  role: "admin" | "sales";
  enabled: boolean;
  hasPassword: boolean;
  version: number;
};
type Draft = {
  name: string;
  login: string;
  role: "admin" | "sales";
  enabled: boolean;
  password: string;
  confirm: string;
};
const blank: Draft = {
  name: "",
  login: "",
  role: "sales",
  enabled: true,
  password: "",
  confirm: "",
};
export default function Accounts({
  active,
  currentId,
  onIdentityChange,
}: {
  active: boolean;
  currentId: string;
  onIdentityChange: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<Account | "new" | null>(null),
    [draft, setDraft] = useState<Draft>(blank),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    sequence = useRef(0);
  const load = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const value = await api<{ accounts: Account[] }>("/accounts");
      if (id !== sequence.current) return;
      setAccounts(value.accounts);
      setLoaded(true);
      setError("");
    } catch (error) {
      if (id === sequence.current) setError(errorText(error));
    }
  }, []);
  useEffect(() => {
    if (active) void load();
    return () => {
      sequence.current++;
    };
  }, [active, load]);
  useEffect(() => {
    if (active && editing && !dialog.current?.open) dialog.current?.showModal();
    if (!active) dialog.current?.close();
  }, [active, editing]);
  function open(account: Account | "new") {
    setFormError("");
    setEditing(account);
    setDraft(
      account === "new"
        ? { ...blank }
        : {
            name: account.name,
            login: account.login,
            role: account.role,
            enabled: account.enabled,
            password: "",
            confirm: "",
          },
    );
  }
  function close() {
    if (busy) return;
    setEditing(null);
    setDraft({ ...blank });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    if (draft.password !== draft.confirm) {
      setFormError("Пароли не совпадают.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const { confirm, password, ...fields } = draft;
      await api(editing === "new" ? "/accounts" : `/accounts/${editing.id}`, {
        method: editing === "new" ? "POST" : "PATCH",
        body: JSON.stringify({
          ...fields,
          ...(password ? { password } : {}),
          ...(editing !== "new" ? { version: editing.version } : {}),
        }),
      });
      const self = editing !== "new" && editing.id === currentId;
      setEditing(null);
      setDraft({ ...blank });
      await load();
      if (self) onIdentityChange();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHead
        eyebrow="КОМАНДА"
        title="Аккаунты"
        description="Персональный вход и понятная история работы с заявками."
      >
        <div className="button-row">
          <button className="button secondary" onClick={() => void load()}>
            <RefreshCw size={16} />
            Обновить
          </button>
          <button className="button primary" onClick={() => open("new")}>
            <Plus size={16} />
            Создать аккаунт
          </button>
        </div>
      </PageHead>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="accounts-summary">
        <span className="square-icon lime">
          <UsersRound size={23} />
        </span>
        <div>
          <h2>Команда пространства</h2>
          <p>
            Администратор управляет аккаунтами. Сотрудники используют рабочие
            сервисы и подписывают действия своим именем.
          </p>
        </div>
        <span className="card-tag">ОБЩИЙ ВХОД СОХРАНЁН</span>
      </div>
      {!loaded ? (
        <Loading />
      ) : !accounts.length ? (
        <Empty
          title="Пока нет персональных аккаунтов"
          text="Создайте аккаунт сотрудника и задайте ему пароль."
        />
      ) : (
        <section className="panel table-scroll">
          <table className="events accounts-table">
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th>Роль</th>
                <th>Доступ</th>
                <th>
                  <span className="sr-only">Управление</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <span className="account-person">
                      <span className="account-avatar">
                        {initials(account.name)}
                      </span>
                      <span>
                        <strong>{account.name}</strong>
                        <small>
                          {account.login}
                          {account.id === currentId ? " · вы" : ""}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td>
                    {account.role === "admin" ? (
                      <span className="account-role">
                        <ShieldCheck size={14} />
                        Администратор
                      </span>
                    ) : (
                      "Отдел продаж"
                    )}
                  </td>
                  <td>
                    <span
                      className={`account-state ${account.enabled ? "enabled" : ""}`}
                    >
                      {account.enabled
                        ? "Активен"
                        : account.hasPassword
                          ? "Отключён"
                          : "Нужен пароль"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="button secondary"
                      onClick={() => open(account)}
                    >
                      {account.hasPassword ? "Настроить" : "Задать пароль"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="small muted">
        Для подготовленного аккаунта задайте пароль и включите доступ. Смена
        пароля, отключение и смена роли закрывают его действующие сессии.
      </p>
      {editing && (
        <dialog
          ref={dialog}
          className="job-dialog account-dialog"
          aria-labelledby="account-dialog-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <div className="dialog-heading">
            <span className="eyebrow">ДОСТУП СОТРУДНИКА</span>
            <button
              className="icon-button"
              disabled={busy}
              onClick={close}
              aria-label="Закрыть настройки аккаунта"
            >
              <X size={20} />
            </button>
          </div>
          <h2 id="account-dialog-title">
            {editing === "new" ? "Новый аккаунт" : editing.name}
          </h2>
          <form className="account-form" onSubmit={save}>
            {formError && <Notice tone="error">{formError}</Notice>}
            <label>
              Имя сотрудника
              <input
                value={draft.name}
                maxLength={120}
                required
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Логин
              <input
                value={draft.login}
                maxLength={64}
                minLength={3}
                autoComplete="off"
                pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,63}"
                required
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, login: e.target.value })}
              />
            </label>
            <label>
              Роль
              <select
                value={draft.role}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, role: e.target.value as Draft["role"] })
                }
              >
                <option value="sales">Отдел продаж</option>
                <option value="admin">Администратор</option>
              </select>
            </label>
            <label>
              {editing === "new" ? "Пароль" : "Новый пароль"}
              <input
                type="password"
                value={draft.password}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required={
                  editing === "new" || (!editing.hasPassword && draft.enabled)
                }
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, password: e.target.value })
                }
              />
            </label>
            <label>
              Повторите новый пароль
              <input
                type="password"
                value={draft.confirm}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required={Boolean(draft.password)}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, confirm: e.target.value })
                }
              />
            </label>
            <label className="account-enable">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              Доступ включён
            </label>
            <p className="small muted">
              От 12 до 128 символов. Для сохранения текущего пароля оставьте оба
              поля пустыми.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={close}
              >
                Отмена
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить аккаунт"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
