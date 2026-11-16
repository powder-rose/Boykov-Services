import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Eye,
  EyeOff,
  LockKeyhole,
  LoaderCircle,
} from "lucide-react";
import { post, errorText } from "../api";
import { Notice } from "../components/Common";
export default function Login({
  onLogin,
  configured,
}: {
  onLogin: () => void;
  configured: boolean;
}) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await post("/auth/login", { password });
      setPassword("");
      onLogin();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-brand">
        <a className="wordmark" href="/">
          boykov<span>.</span>services
        </a>
        <div className="login-statement">
          <div className="eyebrow">ВНУТРЕННЯЯ ПЛАТФОРМА БОЙКОВ ГРУПП</div>
          <h1>
            Меньше рутины.
            <br />
            <span>Больше дела.</span>
          </h1>
          <p>
            Документы, маркетинг и инструменты команды.
            <br />В одном рабочем пространстве.
          </p>
        </div>
        <div className="brand-art" aria-hidden="true">
          <div className="art-grid" />
          <div className="art-ring" />
          <div className="art-square">
            <ArrowUpRight size={98} strokeWidth={1.2} />
          </div>
          <span>BG / WORKSPACE</span>
        </div>
        <div className="login-foot">
          СОЗДАНО ДЛЯ НАШЕЙ КОМАНДЫ <span>01 — ∞</span>
        </div>
      </section>
      <section className="login-form-wrap">
        <div className="login-form">
          <span className="login-lock">
            <LockKeyhole size={24} />
          </span>
          <div className="eyebrow">РАДЫ ВАС ВИДЕТЬ</div>
          <h2>За работу.</h2>
          <p className="muted">Введите пароль команды, чтобы продолжить.</p>
          {!configured && (
            <Notice>
              Первый запуск: задайте пароль командой <code>npm run setup</code>{" "}
              и перезапустите приложение.
            </Notice>
          )}
          <form onSubmit={submit}>
            <label htmlFor="password">Пароль пространства</label>
            <div className="password-input">
              <input
                id="password"
                type={visible ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                required
                maxLength={256}
                placeholder="Введите пароль"
              />
              <button
                className="icon-button"
                type="button"
                onClick={() => setVisible(!visible)}
                aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
              >
                {visible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            <button
              className="button primary login-submit"
              disabled={busy || !configured}
            >
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <>
                  Войти в пространство
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <div className="access-note">
            <span className="tiny-dot" />
            Доступ только для сотрудников компании
          </div>
        </div>
        <span className="login-caption">
          boykov.services / внутреннее пространство
        </span>
      </section>
    </main>
  );
}
