import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Upload,
  Sparkles,
  LoaderCircle,
  ArrowDownToLine,
  Plus,
  PencilLine,
  X,
} from "lucide-react";
import templates from "../../shared/templates.json";
import { api, post, errorText } from "../api";
import { Notice, PageHead, Status } from "../components/Common";
import type { Job, System } from "../types";

export const COMPANY_LABELS = [
  "Организационно-правовая форма",
  "Должность руководителя · родительный падеж",
  "Должность руководителя",
  "ФИО руководителя · родительный падеж",
  "ФИО руководителя",
  "ИНН",
  "Юридический адрес",
  "Наименование банка",
  "Расчётный счёт",
  "Корреспондентский счёт",
  "БИК",
  "КПП · при наличии",
  "ОГРН / ОГРНИП",
  "Наименование организации",
];
const emptyCompany = () => Array.from({ length: 14 }, () => "");
const defaultTerms = {
  cost_month: 5200,
  months_count: 3,
  advance: 100,
  advance_period: "за один месяц",
  visits_frequency: "Ежеквартально",
  termination_period: "30 (тридцать) календарных дней",
  object_address: "",
  object_name: "",
  email: "",
};
const newService = () => ({
  name: "",
  working_days: 10,
  quantity: 1,
  price: 15000,
});
function missingCompany(company: string[]) {
  const entrepreneur = /^(ип|индивидуальный предприниматель)$/i.test(
    company[0].trim(),
  );
  return company
    .map((value, i) => ({ value: value.trim().toLowerCase(), i }))
    .filter(
      ({ value, i }) =>
        i !== 11 &&
        !(entrepreneur && i === 13) &&
        [
          "",
          "-",
          "—",
          "нет",
          "не указано",
          "отсутствует",
          "none",
          "null",
          "нет данных",
          "неизвестно",
        ].includes(value),
    )
    .map(({ i }) => i);
}
export default function Contracts({
  system,
  onChange,
}: {
  system: System | null;
  onChange: () => void;
}) {
  const [step, setStep] = useState(0);
  const [template, setTemplate] = useState("passport_security");
  const [surname, setSurname] = useState("");
  const [cost, setCost] = useState(15000);
  const [complects, setComplects] = useState(0);
  const [workplaces, setWorkplaces] = useState(1);
  const [terms, setTerms] = useState(defaultTerms);
  const [services, setServices] = useState([newService()]);
  const [source, setSource] = useState("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [scan, setScan] = useState(false);
  const [company, setCompany] = useState<string[]>(emptyCompany);
  const [extraction, setExtraction] = useState<Job | null>(null);
  const [generation, setGeneration] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(false);
  const [edited, setEdited] = useState(false);
  const generationRequest = useRef<{ id: string; signature: string } | null>(
    null,
  );
  const extractRequest = useRef<{ id: string; signature: string } | null>(null);
  const waiting = (job: Job | null) =>
    Boolean(job && ["queued", "running"].includes(job.status));
  const isWorking = waiting(extraction) || waiting(generation) || busy;
  const missing = missingCompany(company);
  const templateInfo = templates.find((item) => item.id === template)!;
  const serviceTotal = services.reduce(
    (total, item) => total + item.quantity * item.price,
    0,
  );
  const contractCost = template === "ser_one_time" ? serviceTotal : cost;
  function updateService(
    index: number,
    field: keyof ReturnType<typeof newService>,
    value: string | number,
  ) {
    setServices((current) =>
      current.map((item, i) =>
        i === index ? { ...item, [field]: value } : item,
      ),
    );
  }
  useEffect(() => {
    const current = waiting(extraction)
      ? extraction
      : waiting(generation)
        ? generation
        : null;
    if (!current) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const job = await api<Job>(`/contracts/jobs/${current.id}`);
        if (stopped) return;
        if (job.kind === "extract") {
          setExtraction(job);
          if (job.status === "completed" && job.result?.company) {
            setCompany(job.result.company);
            setEdited(true);
          }
        } else setGeneration(job);
        if (["failed", "completed"].includes(job.status)) onChange();
        if (job.error) setError(job.error);
      } catch (error) {
        if (!stopped) setError(errorText(error));
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [
    extraction?.id,
    extraction?.status,
    generation?.id,
    generation?.status,
    onChange,
  ]);
  function updateTerm(key: keyof typeof terms, value: string | number) {
    setTerms((old) => ({ ...old, [key]: value }));
  }
  function selectFile(value: File | null) {
    setError("");
    if (value && value.size > 20 * 1024 * 1024) {
      setError("Файл должен быть не больше 20 МБ.");
      return;
    }
    setFile(value);
  }
  function nextFromTerms(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (
      template === "ser_one_time" &&
      services.some((item) => !item.name.trim())
    ) {
      setError("Укажите название каждой услуги.");
      return;
    }
    if (template === "ser_one_time" && serviceTotal > 1000000000) {
      setError("Общая стоимость услуг не должна превышать 1 000 000 000 ₽.");
      return;
    }
    setStep(1);
  }
  async function extract() {
    setError("");
    setBusy(true);
    const mode =
      source === "text"
        ? "text"
        : scan
          ? "scan"
          : file && /\.(png|jpe?g)$/i.test(file.name)
            ? "image"
            : "document";
    const signature = JSON.stringify([
      mode,
      text,
      file?.name,
      file?.size,
      file?.lastModified,
    ]);
    if (
      !extractRequest.current ||
      extractRequest.current.signature !== signature ||
      extraction?.status === "failed"
    )
      extractRequest.current = { id: crypto.randomUUID(), signature };
    const form = new FormData();
    form.set("requestId", extractRequest.current.id);
    form.set("mode", mode);
    if (source === "text") form.set("text", text);
    else if (file) form.set("file", file);
    try {
      const job = await api<Job>("/contracts/extract", {
        method: "POST",
        body: form,
      });
      setExtraction(job);
      if (job.status === "completed" && job.result?.company) {
        setCompany(job.result.company);
        setEdited(true);
      }
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    setBusy(true);
    setError("");
    const payload = {
      template,
      surname,
      cost: contractCost,
      complects,
      workplaces_count: workplaces,
      company,
      ser_fields: terms,
      one_time_services: template === "ser_one_time" ? services : [],
      allowIncomplete: draft,
    };
    const signature = JSON.stringify(payload);
    if (
      !generationRequest.current ||
      generationRequest.current.signature !== signature ||
      generation?.status === "failed"
    )
      generationRequest.current = { id: crypto.randomUUID(), signature };
    try {
      setGeneration(
        await post<Job>("/contracts/generate", {
          ...payload,
          requestId: generationRequest.current.id,
        }),
      );
      onChange();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setStep(0);
    setCompany(emptyCompany());
    setText("");
    setFile(null);
    setExtraction(null);
    setGeneration(null);
    setError("");
    setDraft(false);
    setEdited(false);
    generationRequest.current = null;
    extractRequest.current = null;
  }
  return (
    <>
      <PageHead
        eyebrow="ДОКУМЕНТЫ / 01"
        title="Договоры без рутины"
        description="От реквизитов до готового документа — за несколько шагов."
      />
      <div className="steps" aria-label="Этапы подготовки">
        {["Условия договора", "Реквизиты клиента", "Проверка и результат"].map(
          (label, i) => (
            <button
              key={label}
              className={step === i ? "current" : step > i ? "done" : ""}
              disabled={i > step || isWorking}
              onClick={() => setStep(i)}
            >
              <span>{step > i ? <Check size={14} /> : `0${i + 1}`}</span>
              {label}
            </button>
          ),
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!system?.documents.available && system && (
        <Notice>
          Сервис документов недоступен. Проверьте его запуск в разделе
          «Подключения».
        </Notice>
      )}
      {generation?.status === "completed" ? (
        <section className="panel success-panel">
          <div className="success-icon">
            <Check size={29} />
          </div>
          <div className="eyebrow">ВСЁ ГОТОВО</div>
          <h2>Документ подготовлен</h2>
          <p>
            {generation.result?.number
              ? `№ ${generation.result.number} · `
              : ""}
            {templateInfo.label}
          </p>
          <p className="muted">
            Скачайте файл Word с заполненной таблицей автозамен.
            <br />
            Результат также сохранён в истории задач.
          </p>
          {generation.result?.draft && (
            <Notice>
              Создан черновик: проверьте пропуски, отмеченные в документе.
            </Notice>
          )}
          <div className="button-row">
            <a className="button primary" href={generation.downloadUrl || "#"}>
              <ArrowDownToLine size={17} />
              Скачать DOCM
            </a>
            <button className="button secondary" onClick={reset}>
              <Plus size={17} />
              Новый документ
            </button>
          </div>
        </section>
      ) : (
        <div className="work-layout">
          <section className="panel form-panel">
            {step === 0 && (
              <form onSubmit={nextFromTerms}>
                <div className="form-heading">
                  <span className="step-mark">01</span>
                  <div>
                    <h2>Что будем готовить?</h2>
                    <p>Выберите шаблон и укажите условия</p>
                  </div>
                </div>
                <div className="template-grid">
                  {templates.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => setTemplate(item.id)}
                      className={`template-option ${template === item.id ? "selected" : ""}`}
                      aria-pressed={template === item.id}
                    >
                      <FileText size={19} />
                      <strong>{item.label}</strong>
                      <span>{item.company}</span>
                      {template === item.id && (
                        <Check size={15} className="template-check" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="form-divider" />
                <div className="field-grid">
                  <label>
                    Фамилия сотрудника
                    <input
                      required
                      value={surname}
                      minLength={2}
                      maxLength={80}
                      pattern="[А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z \-]+"
                      onChange={(e) => setSurname(e.target.value)}
                      placeholder="Например, Сировская"
                    />
                    <small>По фамилии формируется код документа</small>
                  </label>
                  {template !== "ser" && template !== "ser_one_time" && (
                    <label>
                      Стоимость услуги, ₽
                      <input
                        required
                        type="number"
                        min={0}
                        max={1000000000}
                        value={cost}
                        onChange={(e) => setCost(Number(e.target.value))}
                      />
                    </label>
                  )}
                  {["specons", "ser_one_time"].includes(template) && (
                    <label>
                      Количество комплектов
                      <input
                        required
                        type="number"
                        min={0}
                        max={100000}
                        value={complects}
                        onChange={(e) => setComplects(Number(e.target.value))}
                      />
                      <small>
                        Печать: 3 900 ₽/комплект. Доставка: 1 000 ₽.
                      </small>
                    </label>
                  )}
                  {template === "sout" && (
                    <label>
                      Количество рабочих мест
                      <input
                        required
                        type="number"
                        min={1}
                        max={100000}
                        value={workplaces}
                        onChange={(e) => setWorkplaces(Number(e.target.value))}
                      />
                    </label>
                  )}
                  {template === "ser" && (
                    <>
                      <label>
                        Обслуживание в месяц, ₽
                        <input
                          required
                          type="number"
                          min={0}
                          max={1000000000}
                          value={terms.cost_month}
                          onChange={(e) =>
                            updateTerm("cost_month", Number(e.target.value))
                          }
                        />
                      </label>
                      <label>
                        Количество месяцев
                        <input
                          required
                          type="number"
                          min={1}
                          max={120}
                          value={terms.months_count}
                          onChange={(e) =>
                            updateTerm("months_count", Number(e.target.value))
                          }
                        />
                      </label>
                      <label>
                        Аванс, %
                        <input
                          required
                          type="number"
                          min={0}
                          max={100}
                          value={terms.advance}
                          onChange={(e) =>
                            updateTerm("advance", Number(e.target.value))
                          }
                        />
                      </label>
                      <label>
                        Период аванса
                        <select
                          value={terms.advance_period}
                          onChange={(e) =>
                            updateTerm("advance_period", e.target.value)
                          }
                        >
                          {[
                            "за один месяц",
                            "за два месяца",
                            "за три месяца",
                          ].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Частота выездов
                        <select
                          value={terms.visits_frequency}
                          onChange={(e) =>
                            updateTerm("visits_frequency", e.target.value)
                          }
                        >
                          {[
                            "Ежеквартально",
                            "Ежемесячно",
                            "Один раз в два месяца",
                          ].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Предупреждение о расторжении
                        <select
                          value={terms.termination_period}
                          onChange={(e) =>
                            updateTerm("termination_period", e.target.value)
                          }
                        >
                          {[
                            "30 (тридцать) календарных дней",
                            "60 (шестьдесят) календарных дней",
                            "90 (девяносто) календарных дней",
                          ].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Наименование объекта
                        <input
                          required
                          value={terms.object_name}
                          maxLength={500}
                          onChange={(e) =>
                            updateTerm("object_name", e.target.value)
                          }
                        />
                      </label>
                      <label className="full-width">
                        Адрес объекта
                        <input
                          required
                          value={terms.object_address}
                          maxLength={1000}
                          onChange={(e) =>
                            updateTerm("object_address", e.target.value)
                          }
                        />
                      </label>
                      <label>
                        Почта заказчика
                        <input
                          required
                          type="email"
                          value={terms.email}
                          maxLength={254}
                          onChange={(e) => updateTerm("email", e.target.value)}
                        />
                      </label>
                    </>
                  )}
                </div>
                {template === "ser_one_time" && (
                  <section
                    className="service-specification"
                    aria-label="Услуги в приложении №1"
                  >
                    <div className="section-heading">
                      <div>
                        <h3>Перечень услуг</h3>
                        <p className="muted small">
                          Приложение №1 · от 1 до 9 услуг
                        </p>
                      </div>
                    </div>
                    {services.map((item, index) => (
                      <div className="service-item" key={index}>
                        <div className="service-item-heading">
                          <strong>Услуга {index + 1}</strong>
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`Удалить услугу ${index + 1}`}
                            disabled={services.length === 1}
                            onClick={() =>
                              setServices((current) =>
                                current.filter((_, i) => i !== index),
                              )
                            }
                          >
                            <X size={17} />
                          </button>
                        </div>
                        <div className="field-grid">
                          <label className="full-width">
                            Наименование услуги
                            <textarea
                              required
                              rows={2}
                              maxLength={500}
                              value={item.name}
                              onChange={(e) =>
                                updateService(index, "name", e.target.value)
                              }
                            />
                          </label>
                          <label>
                            Срок, рабочих дней
                            <input
                              required
                              type="number"
                              min={1}
                              max={3650}
                              step={1}
                              value={item.working_days}
                              onChange={(e) =>
                                updateService(
                                  index,
                                  "working_days",
                                  Number(e.target.value),
                                )
                              }
                            />
                          </label>
                          <label>
                            Количество комплектов услуги
                            <input
                              required
                              type="number"
                              min={1}
                              max={100000}
                              step={1}
                              value={item.quantity}
                              onChange={(e) =>
                                updateService(
                                  index,
                                  "quantity",
                                  Number(e.target.value),
                                )
                              }
                            />
                          </label>
                          <label>
                            Цена за комплект, ₽
                            <input
                              required
                              type="number"
                              min={0}
                              max={1000000000}
                              step={1}
                              value={item.price}
                              onChange={(e) =>
                                updateService(
                                  index,
                                  "price",
                                  Number(e.target.value),
                                )
                              }
                            />
                          </label>
                          <label>
                            Сумма по услуге, ₽
                            <input
                              readOnly
                              value={(
                                item.quantity * item.price
                              ).toLocaleString("ru-RU")}
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="button secondary"
                      disabled={services.length >= 9}
                      onClick={() =>
                        setServices((current) => [...current, newService()])
                      }
                    >
                      <Plus size={16} /> Добавить услугу
                    </button>
                    <p className="service-total">
                      Итого по договору{" "}
                      <strong>{serviceTotal.toLocaleString("ru-RU")} ₽</strong>
                    </p>
                  </section>
                )}
                <div className="form-actions">
                  <span className="muted small">Шаг 1 из 3</span>
                  <button className="button primary">
                    К реквизитам
                    <ArrowRight size={16} />
                  </button>
                </div>
              </form>
            )}
            {step === 1 && (
              <>
                <div className="form-heading">
                  <span className="step-mark">02</span>
                  <div>
                    <h2>Реквизиты клиента</h2>
                    <p>ИИ извлечёт данные. Вы сможете их отредактировать.</p>
                  </div>
                </div>
                <div className="segmented source-tabs">
                  {[
                    ["text", "Текст"],
                    ["file", "Файл или скан"],
                    ["manual", "Вручную"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      disabled={isWorking}
                      className={source === id ? "active" : ""}
                      onClick={() => setSource(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {source !== "manual" && (
                  <>
                    {!system?.documents.aiConfigured && (
                      <Notice>
                        Для распознавания подключите Yandex AI в разделе
                        «Подключения».
                      </Notice>
                    )}
                    {source === "text" ? (
                      <label>
                        Текст с реквизитами
                        <textarea
                          rows={7}
                          maxLength={100000}
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          placeholder={
                            "Вставьте карточку компании или сообщение с реквизитами…\n\nНаименование, ИНН, адрес, руководитель, банковские данные"
                          }
                          disabled={isWorking}
                        />
                      </label>
                    ) : (
                      <>
                        <label
                          className="dropzone"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (!isWorking) selectFile(e.dataTransfer.files[0]);
                          }}
                        >
                          <Upload size={25} />
                          <strong>
                            {file ? file.name : "Выберите или перетащите файл"}
                          </strong>
                          <span>PDF, DOCX, DOCM, DOC, JPG, PNG · до 20 МБ</span>
                          <input
                            type="file"
                            disabled={isWorking}
                            accept=".pdf,.docx,.docm,.doc,.jpg,.jpeg,.png"
                            onChange={(e) =>
                              selectFile(e.target.files?.[0] || null)
                            }
                          />
                        </label>
                        {file && (
                          <button
                            className="text-button"
                            onClick={() => selectFile(null)}
                            disabled={isWorking}
                          >
                            <X size={14} />
                            Убрать файл
                          </button>
                        )}
                        {file?.name.toLowerCase().endsWith(".pdf") && (
                          <label className="check-label">
                            <input
                              type="checkbox"
                              checked={scan}
                              disabled={isWorking}
                              onChange={(e) => setScan(e.target.checked)}
                            />
                            PDF содержит сканы — распознать через OCR
                          </label>
                        )}
                      </>
                    )}
                    <button
                      className="button primary extract-button"
                      onClick={extract}
                      disabled={
                        isWorking ||
                        !system?.documents.aiConfigured ||
                        (source === "text" ? !text.trim() : !file)
                      }
                    >
                      {waiting(extraction) || busy ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <Sparkles size={17} />
                      )}
                      {waiting(extraction)
                        ? "ИИ обрабатывает реквизиты…"
                        : "Распознать с ИИ"}
                    </button>
                    {waiting(extraction) && (
                      <p className="muted small">
                        Можно перейти в другой раздел. Задача продолжится на
                        сервере.
                      </p>
                    )}
                  </>
                )}
                {(source === "manual" || edited) && (
                  <>
                    <div className="form-divider" />
                    <div className="section-heading">
                      <h3>Проверьте данные</h3>
                      <span className="muted small">
                        Результат ИИ требует проверки
                      </span>
                    </div>
                    <div className="field-grid company-fields">
                      {COMPANY_LABELS.map((label, i) => (
                        <label
                          key={label}
                          className={i === 6 ? "full-width" : ""}
                        >
                          {label}
                          <input
                            value={company[i]}
                            maxLength={2000}
                            disabled={isWorking}
                            onChange={(e) =>
                              setCompany(
                                company.map((v, j) =>
                                  i === j ? e.target.value : v,
                                ),
                              )
                            }
                            placeholder={i === 0 ? "ООО / ИП" : ""}
                          />
                        </label>
                      ))}
                    </div>
                  </>
                )}
                <div className="form-actions">
                  <button
                    className="text-button"
                    disabled={isWorking}
                    onClick={() => setStep(0)}
                  >
                    <ArrowLeft size={16} />
                    Назад
                  </button>
                  <button
                    className="button primary"
                    disabled={isWorking || (!edited && source !== "manual")}
                    onClick={() => {
                      setStep(2);
                      setError("");
                    }}
                  >
                    К проверке
                    <ArrowRight size={16} />
                  </button>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <div className="form-heading">
                  <span className="step-mark">03</span>
                  <div>
                    <h2>Всё верно?</h2>
                    <p>Проверьте условия перед подготовкой файла</p>
                  </div>
                </div>
                <dl className="review">
                  <div>
                    <dt>Шаблон</dt>
                    <dd>{templateInfo.label}</dd>
                  </div>
                  <div>
                    <dt>Исполнитель</dt>
                    <dd>{templateInfo.company}</dd>
                  </div>
                  <div>
                    <dt>Сотрудник</dt>
                    <dd>{surname}</dd>
                  </div>
                  <div>
                    <dt>Заказчик</dt>
                    <dd>{company[13] || company[4] || "Не указан"}</dd>
                  </div>
                  <div>
                    <dt>ИНН</dt>
                    <dd>{company[5] || "Не указан"}</dd>
                  </div>
                  <div>
                    <dt>
                      {template === "ser"
                        ? "Стоимость за весь период"
                        : "Стоимость услуги"}
                    </dt>
                    <dd>
                      {(template === "ser"
                        ? terms.cost_month * terms.months_count
                        : contractCost
                      ).toLocaleString("ru-RU")}{" "}
                      ₽
                    </dd>
                  </div>
                  {template === "ser" && (
                    <>
                      <div>
                        <dt>Объект</dt>
                        <dd>
                          {terms.object_name} · {terms.object_address}
                        </dd>
                      </div>
                      <div>
                        <dt>Период обслуживания</dt>
                        <dd>{terms.months_count} мес. с текущего месяца</dd>
                      </div>
                    </>
                  )}
                  {template === "sout" && (
                    <div>
                      <dt>Рабочих мест</dt>
                      <dd>{workplaces}</dd>
                    </div>
                  )}
                  {template === "ser_one_time" && (
                    <div>
                      <dt>Приложение №1</dt>
                      <dd>
                        {services
                          .map(
                            (item) =>
                              `${item.name} · ${item.working_days} раб. дн. · ${item.quantity} компл.`,
                          )
                          .join("; ")}
                      </dd>
                    </div>
                  )}
                  {["specons", "ser_one_time"].includes(template) && (
                    <div>
                      <dt>Печать и доставка</dt>
                      <dd>
                        {complects
                          ? (3900 * complects + 1000).toLocaleString("ru-RU")
                          : 0}{" "}
                        ₽ · {complects} компл.
                      </dd>
                    </div>
                  )}
                </dl>
                {missing.length > 0 && (
                  <Notice>
                    Не заполнено полей: {missing.length}.{" "}
                    {missing.map((i) => COMPANY_LABELS[i]).join(", ")}.
                  </Notice>
                )}
                {missing.length > 0 && (
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={draft}
                      onChange={(e) => setDraft(e.target.checked)}
                      disabled={isWorking}
                    />
                    Создать черновик с отмеченными пропусками
                  </label>
                )}
                {waiting(generation) && (
                  <Notice tone="info">
                    <Status value={generation!.status} /> Документ готовится.
                    Результат появится здесь и в истории.
                  </Notice>
                )}
                <div className="form-actions">
                  <button
                    className="text-button"
                    disabled={isWorking}
                    onClick={() => setStep(1)}
                  >
                    <PencilLine size={16} />
                    Изменить реквизиты
                  </button>
                  <button
                    className="button primary"
                    onClick={generate}
                    disabled={
                      isWorking ||
                      (missing.length > 0 && !draft) ||
                      !system?.documents.available
                    }
                  >
                    {isWorking ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <FileText size={17} />
                    )}
                    {isWorking ? "Подготавливаем…" : "Подготовить документ"}
                  </button>
                </div>
              </>
            )}
          </section>
          <aside className="form-aside">
            <span className="aside-icon">
              <Sparkles size={22} />
            </span>
            <h3>
              Документы,
              <br />а не переписка.
            </h3>
            <p>Знакомые шаблоны из бота теперь доступны прямо в браузере.</p>
            <ul>
              <li>
                <Check size={15} />
                Распознавание текста и сканов
              </li>
              <li>
                <Check size={15} />
                Проверка реквизитов до генерации
              </li>
              <li>
                <Check size={15} />
                Автоматическая нумерация
              </li>
              <li>
                <Check size={15} />
                Результаты в общей истории
              </li>
            </ul>
            <div className="aside-bottom">
              <FileText size={19} />
              <span>
                Формат результата<strong>Word · DOCM</strong>
              </span>
            </div>
            <p className="small muted">
              Файл содержит исходный шаблон и заполненную таблицу автозамен.
              Макросы на сервере не исполняются.
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
