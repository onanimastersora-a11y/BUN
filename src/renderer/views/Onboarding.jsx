import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { makeT, errorText } from '../i18n.js';
import { PixelSprite } from '../sprite.jsx';
import { Icon } from '../icons.jsx';
import logoUrl from '../assets/logo.svg';

export default function Onboarding() {
  const [lang, setLang] = useState(() => localStorage.getItem('bun-lang') || 'vi');
  const t = useMemo(() => makeT(lang), [lang]);
  const [step, setStep] = useState('pick'); // pick | name | login
  const [animal, setAnimal] = useState(null);
  const [hover, setHover] = useState(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const switchLang = (l) => {
    setLang(l);
    localStorage.setItem('bun-lang', l);
  };

  // Each form starts clean, so a half-typed login never leaks into sign-up.
  const goTo = (next) => {
    setName('');
    setCode('');
    setError('');
    setStep(next);
  };

  const pick = (a) => {
    setAnimal(a);
    goTo('name');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (step === 'login') await api.login({ name, code });
      else await api.register({ animal, name, code });
      await api.updateSettings({ language: lang });
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  };

  return (
    <div className="onboard">
      <div className="onboard__top">
        <div className="onboard__brand">
          <img src={logoUrl} alt="" />
          <span>BUN</span>
        </div>
        <div className="segmented">
          <button className={lang === 'vi' ? 'is-on' : ''} onClick={() => switchLang('vi')}>
            VI
          </button>
          <button className={lang === 'en' ? 'is-on' : ''} onClick={() => switchLang('en')}>
            EN
          </button>
        </div>
      </div>

      {step === 'pick' && (
        <div className="onboard__stage" key="pick">
          <h1 className="onboard__title">{t('ob.question')}</h1>
          <p className="onboard__sub">{t('ob.questionSub')}</p>
          <div className="onboard__choices">
            {['cat', 'dog'].map((a) => (
              <button
                key={a}
                className={`choice choice--${a}`}
                onMouseEnter={() => setHover(a)}
                onMouseLeave={() => setHover(null)}
                onClick={() => pick(a)}
              >
                <div className="choice__art">
                  <PixelSprite animal={a} anim={hover === a ? 'alert' : 'sit'} scale={5} />
                </div>
                <span className="choice__label">{t(`ob.${a}`)}</span>
              </button>
            ))}
          </div>
          <button className="onboard__link" onClick={() => goTo('login')}>
            {t('ob.haveAccount')}
          </button>
        </div>
      )}

      {step !== 'pick' && (
        <div className="onboard__stage onboard__stage--form" key={step}>
          <div className="onboard__pet">
            {step === 'name' ? <PixelSprite animal={animal} anim="sit" scale={6} /> : <img src={logoUrl} alt="" className="onboard__logo-big" />}
          </div>
          <form className="onboard__form" onSubmit={submit}>
            <h1 className="onboard__title onboard__title--left">
              {step === 'login' ? t('ob.loginTitle') : animal === 'cat' ? t('ob.nameCat') : t('ob.nameDog')}
            </h1>
            {step === 'name' && <p className="onboard__sub onboard__sub--left">{t('ob.nameSub')}</p>}

            <label className="label" htmlFor="ob-name">
              {step === 'login' ? t('ob.loginName') : t('ob.nameLabel')}
            </label>
            <input
              id="ob-name"
              className="input input--lg"
              value={name}
              autoFocus
              maxLength={step === 'login' ? 30 : 24}
              placeholder={t('ob.namePh')}
              onChange={(e) => setName(e.target.value)}
            />

            <label className="label" htmlFor="ob-code" style={{ marginTop: 18 }}>
              {t('ob.code')}
            </label>
            <div className="code-input">
              <input
                id="ob-code"
                className="input input--lg"
                type={showCode ? 'text' : 'password'}
                value={code}
                placeholder={t('ob.codePh')}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="button" className="icon-btn" onClick={() => setShowCode(!showCode)} tabIndex={-1}>
                <Icon name={showCode ? 'eyeOff' : 'eye'} size={17} />
              </button>
            </div>
            {step === 'name' && <p className="onboard__hint">{t('ob.codeHint')}</p>}
            {error && <p className="onboard__error">{error}</p>}

            <button className="btn btn--primary btn--lg" disabled={!name.trim() || code.length < 4 || busy}>
              {step === 'login' ? t('ob.login') : t('ob.start')}
              <Icon name="chevronRight" size={17} />
            </button>

            <div className="onboard__links">
              {step === 'name' ? (
                <button type="button" className="onboard__link" onClick={() => goTo('pick')}>
                  <Icon name="arrowLeft" size={14} /> {t('ob.back')}
                </button>
              ) : (
                <button type="button" className="onboard__link" onClick={() => goTo('pick')}>
                  {t('ob.newAccount')}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
