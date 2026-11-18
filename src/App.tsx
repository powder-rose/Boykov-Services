import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  FileText,
  History as HistoryIcon,
  ClipboardList,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, post, errorText, dateTime } from "./api";
import { Loading, Notice, Status } from "./components/Common";
import Login from "./pages/Login";
import Overview from "./pages/Overview";
import Contracts from "./pages/Contracts";
import Technical from "./pages/Technical";
import Leads from "./pages/Leads";
import Wordstat from "./pages/Wordstat";
import History from "./pages/History";
import Settings from "./pages/Settings";
import type { Dashboard, Job, Page, System } from "./types";
const navigation = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  {
    id: "contracts",
    label: "Договоры",
    icon: FileText,
    group: "СЕРВИСЫ КОМПАНИИ",
  },
  { id: "technical", label: "Техотдел", icon: ClipboardList },
  { id: "leads", label: "Заявки", icon: Inbox },
  { id: "wordstat", label: "Wordstat", icon: Search },
  {
    id: "history",
    label: "История задач",
    icon: HistoryIcon,
    group: "ПРОСТРАНСТВО",
  },
  { id: "settings", label: "Подключения", icon: Settings2 },
] as const;
const getPage = (): Page =>
  navigation.some((n) => n.id === location.hash.slice(1))
    ? (location.hash.slice(1) as Page)
    : "overview";
const emptyDashboard: Dashboard = {
  events: [],
  documentsAvailable: true,
  stats: { documents: 0, batches: 0, active: 0 },
};
export default function App() {
  const [session, setSession] = useState<{
    authenticated: boolean;
    configured: boolean;
  } | null>(null);
  const [page, setPage] = useState<Page>(getPage);
  const [dashboard, setDashboard] = useState<Dashboard>(emptyDashboard);
  const [system, setSystem] = useState<System | null>(null);
  const [initialError, setInitialError] = useState("");
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState("");
  const modalRef = useRef<HTMLDialogElement>(null);
  const sessionRef = useRef(false);
  const checkSession = useCallback(async () => {
    try {
      const value = await api<{ authenticated: boolean; configured: boolean }>(
        "/auth/session",
      );
      setSession(value);
      setInitialError("");
    } catch (error) {
      setInitialError(errorText(error));
    }
  }, []);
  const refresh = useCallback(async () => {
    const result = await Promise.allSettled([
      api<Dashboard>("/dashboard"),
      api<System>("/system"),
    ]);
    if (!sessionRef.current) return;
    if (result[0].status === "fulfilled") {
      setDashboard(result[0].value);
      setError("");
    } else setError(errorText(result[0].reason));
    if (result[1].status === "fulfilled") setSystem(result[1].value);
  }, []);
  useEffect(() => {
    void checkSession();
    const listener = () => {
      sessionRef.current = false;
      setSession((s) => ({
        configured: s?.configured ?? true,
        authenticated: false,
      }));
    };
    window.addEventListener("session-expired", listener);
    return () => window.removeEventListener("session-expired", listener);
  }, [checkSession]);
  useEffect(() => {
    const listener = () => setPage(getPage());
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    sessionRef.current = Boolean(session?.authenticated);
    if (!session?.authenticated) return;
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [session?.authenticated, refresh]);
  function navigate(next: Page) {
    location.hash = next;
    setPage(next);
    setMobile(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function searchHistory() {
    navigate("history");
    setTimeout(() => document.getElementById("history-search")?.focus(), 80);
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k" && sessionRef.current) {
        e.preventDefault();
        location.hash = "history";
        setPage("history");
        setTimeout(
          () => document.getElementById("history-search")?.focus(),
          80,
        );
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  async function logout() {
    try {
      await post("/auth/logout", {});
      sessionRef.current = false;
      setSession((s) => ({
        configured: s?.configured ?? true,
        authenticated: false,
      }));
      setDashboard(emptyDashboard);
      setSystem(null);
      setSelectedJob(null);
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function openJob(job: Job) {
    if (job.service === "wordstat") {
      setSelectedBatch(job.id);
      navigate("wordstat");
      return;
    }
    setSelectedJob(job);
    setJobError("");
    try {
      const full = await api<Job>(`/contracts/jobs/${job.id}`);
      setSelectedJob((current) =>
        current?.id === job.id ? { ...full, service: "contracts" } : current,
      );
    } catch (error) {
      setJobError(errorText(error));
    }
  }
  useEffect(() => {
    if (selectedJob && !modalRef.current?.open) modalRef.current?.showModal();
  }, [selectedJob]);
  if (!session)
    return (
      <div className="startup">
        {initialError ? (
          <div>
            <Notice tone="error">
              Не удалось подключиться к серверу. {initialError}
            </Notice>
            <button className="button primary" onClick={checkSession}>
              Повторить
            </button>
          </div>
        ) : (
          <Loading />
        )}
      </div>
    );
  if (!session.authenticated)
    return <Login configured={session.configured} onLogin={checkSession} />;
  const today = new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Moscow",
  }).format(new Date());
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="sidebar-overlay"
          aria-label="Закрыть меню"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <a
          className="wordmark"
          href="#overview"
          onClick={() => navigate("overview")}
        >
          boykov<span>.</span>services
        </a>
        <div className="workspace-label">
          <span className="workspace-symbol">BG</span>
          <span>
            БОЙКОВ ГРУПП<small>Рабочее пространство</small>
          </span>
          <ShieldCheck size={16} />
        </div>
        <nav aria-label="Главная навигация">
          {navigation.map((item) => (
            <div key={item.id}>
              {"group" in item && <div className="nav-group">{item.group}</div>}
              <button
                className={`nav-item ${page === item.id ? "active" : ""}`}
                onClick={() => navigate(item.id)}
                aria-current={page === item.id ? "page" : undefined}
              >
                <item.icon size={19} strokeWidth={1.7} />
                <span>{item.label}</span>
                {item.id === "leads" && Boolean(dashboard.stats.newLeads) && (
                  <span
                    className="nav-counter"
                    aria-label={`Новых заявок: ${dashboard.stats.newLeads}`}
                  >
                    {dashboard.stats.newLeads}
                  </span>
                )}
                {page === item.id && <span className="nav-dot" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span>Единый доступ к инструментам</span>
            <p>Больше времени на важное.</p>
            <span className="sidebar-mini-art" aria-hidden="true">
              ✳
            </span>
          </div>
          <button className="help-link" onClick={() => navigate("settings")}>
            <CircleHelp size={17} />
            Как всё подключить
            <ArrowUpRight size={15} />
          </button>
          <div className="team-profile">
            <span className="avatar">Б</span>
            <span>
              Команда Бойков<small>Общий доступ</small>
            </span>
            <button
              className="icon-button"
              onClick={logout}
              aria-label="Выйти из пространства"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
              aria-label="Открыть меню"
            >
              <Menu size={22} />
            </button>
            <span>Пространство</span>
            <ChevronRight size={13} />
            <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="topbar-actions">
            <span className="today">{today}</span>
            <button className="global-search" onClick={searchHistory}>
              <Search size={16} />
              <span>Поиск по истории</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className="top-avatar" aria-label="Команда">
              Б
            </span>
          </div>
        </header>
        <main className="main-content">
          {error && (
            <Notice tone="error">
              {error}{" "}
              <button className="text-button" onClick={refresh}>
                Повторить
              </button>
            </Notice>
          )}
          <div hidden={page !== "overview"} className="page">
            <Overview
              dashboard={dashboard}
              system={system}
              navigate={navigate}
              onOpen={openJob}
            />
          </div>
          <div hidden={page !== "contracts"} className="page">
            <Contracts system={system} onChange={refresh} />
          </div>
          <div hidden={page !== "technical"} className="page">
            <Technical />
          </div>
          <div hidden={page !== "leads"} className="page">
            <Leads active={page === "leads"} onChange={refresh} />
          </div>
          <div hidden={page !== "wordstat"} className="page">
            <Wordstat
              system={system}
              selectedId={selectedBatch}
              onChange={refresh}
            />
          </div>
          <div hidden={page !== "history"} className="page">
            <History dashboard={dashboard} onOpen={openJob} />
          </div>
          <div hidden={page !== "settings"} className="page">
            <Settings system={system} refresh={refresh} />
          </div>
        </main>
        <footer className="app-footer">
          <span>boykov.services</span>
          <span>Внутренние инструменты команды</span>
          <span>Сделано, чтобы работать проще.</span>
        </footer>
      </div>
      {selectedJob && (
        <dialog
          ref={modalRef}
          className="job-dialog"
          onCancel={() => setSelectedJob(null)}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              modalRef.current?.close();
              setSelectedJob(null);
            }
          }}
        >
          <div className="dialog-heading">
            <span className="eyebrow">ДОКУМЕНТЫ</span>
            <button
              className="icon-button"
              onClick={() => {
                modalRef.current?.close();
                setSelectedJob(null);
              }}
              aria-label="Закрыть"
            >
              <X size={20} />
            </button>
          </div>
          <h2>{selectedJob.title}</h2>
          <p className="muted">{dateTime(selectedJob.createdAt)} · МСК</p>
          <Status value={selectedJob.status} />
          {(jobError || selectedJob.error) && (
            <Notice tone="error">{jobError || selectedJob.error}</Notice>
          )}
          {selectedJob.result?.number && (
            <p>Документ № {selectedJob.result.number}</p>
          )}
          {selectedJob.result?.draft && (
            <Notice>
              Черновик с пропусками. Проверьте отмеченные поля в файле.
            </Notice>
          )}
          {selectedJob.downloadUrl && (
            <a className="button primary" href={selectedJob.downloadUrl}>
              <ArrowDownToLine size={17} />
              Скачать DOCM
            </a>
          )}
          {["running", "queued"].includes(selectedJob.status) && (
            <button
              className="button secondary"
              onClick={() => openJob(selectedJob)}
            >
              Обновить статус
            </button>
          )}
        </dialog>
      )}
    </div>
  );
}
