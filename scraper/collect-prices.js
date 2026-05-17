/**
 * collect-prices.js
 *
 * Coleta preços do checkout Hotmart para cada país hispano usando Playwright.
 *
 * ESTRATÉGIA (em ordem de tentativa):
 *   1. Parâmetro de locale na URL (?locale=es_MX)
 *      → Mais rápido. Se a Hotmart aceitar, não precisa clicar em nada.
 *   2. Interação com o botão nativo de seleção de país da Hotmart
 *      → Clica no seletor de país, escolhe o país na lista, espera o preço mudar.
 *   3. Screenshot + HTML salvo para diagnóstico manual
 *      → Se as duas estratégias falharem, salva evidência para você ajustar os seletores.
 *
 * VARIÁVEIS DE AMBIENTE:
 *   CHECKOUT_URL           (obrigatório) URL do checkout
 *   PRICE_SELECTOR         (opcional)   Seletor CSS do elemento de preço
 *   COUNTRY_BTN_SELECTOR   (opcional)   Seletor CSS do botão de seleção de país
 *   COUNTRY_ITEM_SELECTOR  (opcional)   Seletor CSS dos itens na lista de países
 *   HEADLESS               (opcional)   "false" para ver o browser (só local)
 *   DEBUG                  (opcional)   "true" para salvar screenshots de cada país
 *   TIMEOUT_MS             (opcional)   Timeout por operação em ms (padrão: 20000)
 *   STRATEGY               (opcional)   "url" | "ui" | "both" (padrão: "both")
 */

'use strict';

const { chromium } = require('playwright');
const fs            = require('fs');
const path          = require('path');
const COUNTRIES     = require('./countries');

// ─── Configuração via env ─────────────────────────────────────────────────────

const CHECKOUT_URL       = (process.env.CHECKOUT_URL       || '').trim();
const PRICE_SEL_ENV      = (process.env.PRICE_SELECTOR     || '').trim();
const COUNTRY_BTN_ENV    = (process.env.COUNTRY_BTN_SELECTOR  || '').trim();
const COUNTRY_ITEM_ENV   = (process.env.COUNTRY_ITEM_SELECTOR || '').trim();
const IS_HEADLESS        = process.env.HEADLESS !== 'false';
const DEBUG              = process.env.DEBUG === 'true';
const TIMEOUT_MS         = parseInt(process.env.TIMEOUT_MS  || '20000', 10);
const STRATEGY           = process.env.STRATEGY             || 'both'; // "url" | "ui" | "both"

const OUTPUT_PATH        = path.resolve(__dirname, '..', 'hotmart-prices.json');
const SCREENSHOTS_DIR    = path.resolve(__dirname, '..', 'screenshots');

if (!CHECKOUT_URL) {
  console.error('\n[ERRO] Defina a variável de ambiente CHECKOUT_URL\n');
  process.exit(1);
}

// ─── Seletores candidatos para o PREÇO ───────────────────────────────────────
//
// A Hotmart usa React/SPA. O preço pode estar em várias estruturas.
// O script testa todos esses em sequência.

const PRICE_SELECTORS = PRICE_SEL_ENV
  ? [PRICE_SEL_ENV]
  : [
    // Seletores observados em versões do checkout Hotmart (2024-2026)
    '[class*="price-component"] [class*="value"]',
    '[class*="price-component"] strong',
    '[class*="checkout-price"] [class*="value"]',
    '[class*="checkout-price"]',
    '[class*="offer"] [class*="price"]',
    '[class*="OrderBump"] [class*="price"]',
    '[data-testid*="price"]',
    '[data-test*="price"]',
    '.payment-info__price',
    '.price-value',
    // Seletores genéricos: qualquer strong/span dentro de elemento com "price" no nome
    '[class*="price"] > strong',
    '[class*="price"] > span',
    '[class*="valor"]',
    // Último recurso: heading ou parágrafo com símbolo de moeda
    'h1', 'h2', 'h3', 'strong', 'b',
  ];

// ─── Seletores candidatos para o BOTÃO DE SELEÇÃO DE PAÍS ────────────────────
//
// O botão de seleção de país no checkout Hotmart é geralmente:
// - Um elemento com bandeira + código do país (ex: 🇧🇷 BR ou "Brasil")
// - Fica no canto superior da página ou próximo ao preço
// - Clicking abre um modal ou dropdown com a lista de países

const COUNTRY_BTN_SELECTORS = COUNTRY_BTN_ENV
  ? [COUNTRY_BTN_ENV]
  : [
    // Texto visível "Alterar país" / "Cambiar país" (Playwright suporta :has-text)
    'button:has-text("Alterar país")',
    'button:has-text("Cambiar país")',
    'button:has-text("Change country")',
    'a:has-text("Alterar país")',
    'a:has-text("Cambiar país")',
    // Classes específicas observadas na Hotmart
    '[class*="country-selector"]',
    '[class*="CountrySelector"]',
    '[class*="change-country"]',
    '[class*="locale-selector"]',
    '[data-testid*="country"]',
    '[aria-label*="país"]',
    '[aria-label*="country"]',
  ];

// ─── Seletores candidatos para ITENS NA LISTA DE PAÍSES ──────────────────────
//
// Após clicar no botão, aparece uma lista (modal/dropdown).
// Cada item representa um país. Precisamos encontrar pelo nome ou código.

const COUNTRY_ITEM_SELECTORS = COUNTRY_ITEM_ENV
  ? [COUNTRY_ITEM_ENV]
  : [
    '[class*="country-item"]',
    '[class*="CountryItem"]',
    '[class*="country-option"]',
    '[class*="locale-option"]',
    '[role="option"]',
    '[role="menuitem"]',
    '[class*="modal"] li',
    '[class*="dropdown"] li',
    '[class*="list"] li',
    'li[class*="country"]',
  ];

// ─── Padrão de moeda para identificar textos de preço ────────────────────────

// Inclui símbolos locais: S/ (PEN), Bs (BOB), Q (GTQ), L (HNL), ₲/Gs (PYG),
// RD$ (DOP), B/. (PAB), além dos ISO codes e símbolos comuns
const CURRENCY_PATTERN = /S\/|Bs\.?|₲|Gs\.|RD\$|B\/\.?|[$€£₡]|BRL|MXN|COP|ARS|PEN|CLP|BOB|CRC|DOP|GTQ|HNL|PYG|UYU|PAB|USD|EUR/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(emoji, msg)  { console.log(`  ${emoji} ${msg}`); }
function warn(msg)        { console.warn(`  ⚠️  ${msg}`); }

function buildLocaleUrl(baseUrl, locale) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('locale', locale);
    return url.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}locale=${locale}`;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function dismissCookieBanner(page) {
  try {
    const btn = await page.$('button:has-text("Permitir todas"), button:has-text("Permitir todo")');
    if (btn && await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 3000 });
      await sleep(500);
    }
  } catch { /* banner não encontrado, tudo bem */ }
}

function randomDelay(min = 600, max = 1400) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

/**
 * Tenta extrair o preço de qualquer elemento na página que pareça uma moeda.
 * Retorna { raw, amount } ou null.
 */
async function extractPrice(page) {
  // Estratégia A: seletores CSS conhecidos
  for (const sel of PRICE_SELECTORS) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        const text = (await el.innerText().catch(() => '')).trim();
        if (
          text.length > 1 &&
          text.length < 60 &&
          CURRENCY_PATTERN.test(text) &&
          /\d/.test(text)
        ) {
          return parsePrice(text);
        }
      }
    } catch { /* seletor não encontrado */ }
  }

  // Estratégia B: varredura de todos os nós de texto por padrão de moeda
  const found = await page.evaluate((currencyPattern) => {
    const walker  = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const results = [];
    const rx      = new RegExp(currencyPattern);

    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      const el   = walker.currentNode.parentElement;
      if (!el || !text || text.length > 60) continue;

      const fontSize = parseFloat(window.getComputedStyle(el).fontSize || '0');
      if (rx.test(text) && /\d/.test(text)) {
        results.push({ text, fontSize });
      }
    }

    // Ordena por tamanho de fonte: preço principal tende a ser maior
    results.sort((a, b) => b.fontSize - a.fontSize);
    return results.slice(0, 8).map(r => r.text);
  }, CURRENCY_PATTERN.source);

  for (const text of found) {
    const parsed = parsePrice(text);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Extrai valor numérico de uma string de preço.
 *
 * Formatos suportados:
 *   "9.99"      → 9.99   (US: ponto decimal, sem milhar)
 *   "51,99"     → 51.99  (BR/EU: vírgula decimal)
 *   "1,234.56"  → 1234.56 (US com milhar)
 *   "1.234,56"  → 1234.56 (BR/EU com milhar)
 *   "51.990"    → 51990  (CLP/COP: ponto como milhar, sem decimal)
 *   "51,990"    → 51990  (idem com vírgula)
 */
function parsePrice(raw) {
  if (!raw) return null;
  const text     = raw.trim();
  const noSymbol = text.replace(/[^0-9,\.]/g, '');
  if (!noSymbol) return null;

  const hasDot   = noSymbol.includes('.');
  const hasComma = noSymbol.includes(',');
  let amount;

  if (hasDot && hasComma) {
    // Dois separadores: o último é o decimal
    const lastDot   = noSymbol.lastIndexOf('.');
    const lastComma = noSymbol.lastIndexOf(',');
    if (lastComma > lastDot) {
      // "1.234,56" → vírgula é decimal (formato BR/EU)
      amount = parseFloat(noSymbol.replace(/\./g, '').replace(',', '.'));
    } else {
      // "1,234.56" → ponto é decimal (formato US)
      amount = parseFloat(noSymbol.replace(/,/g, ''));
    }
  } else if (hasComma) {
    const afterComma = noSymbol.slice(noSymbol.lastIndexOf(',') + 1);
    if (afterComma.length === 2) {
      // "51,99" → vírgula é decimal
      amount = parseFloat(noSymbol.replace(',', '.'));
    } else {
      // "51,990" → vírgula é milhar (CLP/COP sem centavos)
      amount = parseFloat(noSymbol.replace(/,/g, ''));
    }
  } else if (hasDot) {
    const afterDot = noSymbol.slice(noSymbol.lastIndexOf('.') + 1);
    if (afterDot.length === 2) {
      // "9.99" → ponto é decimal (formato US)
      amount = parseFloat(noSymbol);
    } else {
      // "51.990" → ponto é milhar (CLP/COP sem centavos)
      amount = parseFloat(noSymbol.replace(/\./g, ''));
    }
  } else {
    amount = parseFloat(noSymbol);
  }

  if (isNaN(amount) || amount <= 0) return null;
  return { raw: text, amount };
}

// ─── Estratégia 1: URL locale ─────────────────────────────────────────────────

/**
 * Carrega o checkout com ?locale=LOCALE e extrai o preço.
 * É a estratégia mais simples: sem interação com UI, só parâmetro na URL.
 */
async function tryUrlStrategy(page, country) {
  const url = buildLocaleUrl(CHECKOUT_URL, country.locale);
  log('🔗', `URL locale: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
    await sleep(2000);
    await dismissCookieBanner(page);

    const price = await extractPrice(page);
    if (!price) return null;

    // Valida: se o país usa moeda diferente de USD mas o preço está em formato
    // USD (símbolo $ sem indicação de moeda local), o locale param não funcionou.
    // Nesse caso descarta e deixa a estratégia UI tentar.
    const expectsNonUSD = country.currency !== 'USD';
    const looksLikeUSD  = /^\$[\d,\.]+$/.test(price.raw.trim());
    if (expectsNonUSD && looksLikeUSD) {
      warn(`[URL] Retornou preço em USD ($${price.amount}) para ${country.code} (esperado: ${country.currency}). Locale param ignorado pela Hotmart → tentando UI.`);
      return null;
    }

    log('✓', `[URL] ${price.raw}`);
    return price;
  } catch (err) {
    warn(`URL strategy falhou: ${err.message}`);
  }
  return null;
}

// ─── Estratégia 2: Interação com o botão nativo de seleção de país ───────────

/**
 * Tenta clicar no seletor de país da Hotmart e selecionar o país desejado.
 *
 * O fluxo é:
 *   1. Carrega o checkout (se ainda não carregado)
 *   2. Encontra o botão de seleção de país (flag/country name)
 *   3. Clica no botão → abre modal/dropdown
 *   4. Procura o país pelo nome ou código na lista
 *   5. Clica no país
 *   6. Espera o preço atualizar (aguarda mudança no DOM)
 *   7. Extrai o novo preço
 */
async function tryUIStrategy(page, country) {
  log('🖱️', `UI strategy: buscando botão de seleção de país…`);

  // 2.1 — Encontrar o botão de seleção de país
  let countryBtn = null;

  for (const sel of COUNTRY_BTN_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isVisible();
        if (visible) {
          countryBtn = el;
          log('🔍', `Botão encontrado: "${sel}"`);
          break;
        }
      }
    } catch { /* tenta próximo */ }
  }

  // Fallback: busca por texto "país" / "cambiar" / "alterar" no conteúdo do botão
  if (!countryBtn) {
    const handle = await page.evaluateHandle(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
      return candidates.find(btn => {
        const text = (btn.textContent || '').toLowerCase().trim();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        return text.includes('país') ||
               text.includes('alterar') ||
               text.includes('cambiar') ||
               text.includes('change country') ||
               label.includes('país') ||
               label.includes('country');
      });
    });

    const el = handle.asElement();
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      countryBtn = visible ? el : null;
      if (countryBtn) log('🔍', 'Botão "Alterar/Cambiar país" encontrado por texto.');
    }
  }

  if (!countryBtn) {
    warn('Botão de seleção de país não encontrado na página.');
    return null;
  }

  // 2.2 — Captura o preço ANTES de trocar (para detectar se mudou)
  const priceBefore = await extractPrice(page);
  log('📌', `Preço antes da troca: ${priceBefore ? priceBefore.raw : '(não detectado)'}`);

  // 2.3 — Clica no botão de seleção de país
  try {
    await countryBtn.click({ timeout: 5000 });
    await sleep(1500); // espera o modal/dropdown abrir
    log('✓', 'Botão de país clicado. Aguardando lista de países…');
  } catch (err) {
    warn(`Não foi possível clicar no botão: ${err.message}`);
    return null;
  }

  // 2.4 — Procura o país na lista por múltiplos critérios (aliases + código)
  const targetCode    = country.code;
  const targetAliases = country.aliases && country.aliases.length > 0
    ? country.aliases
    : [country.name];

  function matchesCountry(text) {
    const t = text.toLowerCase().trim();
    return targetAliases.some(alias =>
      t === alias.toLowerCase() || t.includes(alias.toLowerCase())
    );
  }

  let countryItem = null;
  await sleep(1500);

  // Tenta seletores conhecidos de itens de lista
  for (const sel of COUNTRY_ITEM_SELECTORS) {
    try {
      const items = await page.$$(sel);
      for (const item of items) {
        const text    = (await item.innerText().catch(() => '')).trim();
        const visible = await item.isVisible().catch(() => false);
        if (visible && matchesCountry(text)) {
          countryItem = item;
          log('🔍', `País na lista [${sel}]: "${text}"`);
          break;
        }
      }
      if (countryItem) break;
    } catch { /* tenta próximo */ }
  }

  // Fallback: varredura de todos os elementos visíveis usando aliases
  if (!countryItem) {
    const handle = await page.evaluateHandle((aliases) => {
      const all = Array.from(document.querySelectorAll(
        'li, [role="option"], [role="menuitem"], button, a, span, p'
      ));
      return all.find(el => {
        const text    = (el.textContent || '').trim();
        const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        if (!visible || text.length > 80) return false;
        const tLower = text.toLowerCase();
        return aliases.some(a => tLower === a.toLowerCase() || tLower.includes(a.toLowerCase()));
      });
    }, targetAliases);

    // evaluateHandle retorna JSHandle — .asElement() converte para ElementHandle
    const el = handle.asElement();
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        countryItem = el;
        log('🔍', `País encontrado por varredura: ${targetAliases[0]}`);
      }
    }
  }

  if (!countryItem) {
    warn(`País "${targetAliases[0]}" (${targetCode}) não encontrado na lista do seletor.`);
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }

  // 2.5 — Clica no país e aguarda o preço atualizar
  try {
    // A Hotmart pode redirecionar para ?bid=XXXXX após trocar o país
    // Usamos Promise.all para capturar navegação E click simultaneamente
    await Promise.all([
      page.waitForNavigation({ timeout: 10000, waitUntil: 'networkidle' }).catch(() => {}),
      countryItem.click({ timeout: 5000 }),
    ]);
    log('✓', `Clicou em "${targetAliases[0]}". Aguardando preço atualizar…`);
  } catch (err) {
    warn(`Não foi possível clicar em "${targetAliases[0]}": ${err.message}`);
    return null;
  }

  await sleep(2500); // hydration do React

  // 2.6 — Extrai o novo preço
  const priceAfter = await extractPrice(page);

  if (!priceAfter) {
    warn('Preço não encontrado após seleção de país.');
    return null;
  }

  // Verifica se o preço realmente mudou (validação extra)
  if (priceBefore && priceAfter.raw === priceBefore.raw) {
    warn(`Preço não mudou após selecionar ${targetCode} (continua: ${priceAfter.raw}). Pode ser erro de seleção.`);
    // Ainda assim retorna — pode ser que o preço seja igual (ex: dois países em USD)
  }

  log('✓', `[UI] ${priceAfter.raw}`);
  return priceAfter;
}

// ─── Scraper principal ────────────────────────────────────────────────────────

async function run() {
  console.log('\n' + '═'.repeat(56));
  console.log('  Hotmart Price Collector');
  console.log(`  Checkout : ${CHECKOUT_URL}`);
  console.log(`  Países   : ${COUNTRIES.length}`);
  console.log(`  Estratégia: ${STRATEGY} | Debug: ${DEBUG} | Headless: ${IS_HEADLESS}`);
  console.log('═'.repeat(56));

  if (DEBUG) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // ── Lança o browser ───────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: IS_HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=pt-BR',
    ],
  });

  const context = await browser.newContext({
    viewport:  { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });

  // Remove a flag navigator.webdriver para reduzir detecção de bot
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const results = {};
  const errors  = [];

  // ── Itera pelos países ────────────────────────────────────────────────────
  for (const country of COUNTRIES) {
    const { code, locale, currency, name } = country;
    console.log(`\n▶ ${name} (${code}) — ${currency}`);

    let priceData = null;
    const page    = await context.newPage();

    try {
      // ── Estratégia 1: URL locale ─────────────────────────────────────────
      if (STRATEGY === 'url' || STRATEGY === 'both') {
        priceData = await tryUrlStrategy(page, country);
      }

      // ── Estratégia 2: UI com o botão nativo ────────────────────────────
      // Tenta a UI se: (a) estratégia configurada como "ui" ou "both"
      //               (b) a estratégia URL não retornou preço
      if (!priceData && (STRATEGY === 'ui' || STRATEGY === 'both')) {
        // Se a página ainda não foi carregada (URL strategy foi pulada ou falhou antes do goto)
        const currentUrl = page.url();
        if (!currentUrl || currentUrl === 'about:blank') {
          await page.goto(CHECKOUT_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
          await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
          await sleep(2500);
        }
        await dismissCookieBanner(page);
        priceData = await tryUIStrategy(page, country);
      }

      // ── Screenshot de diagnóstico ─────────────────────────────────────
      if (DEBUG) {
        const screenshotPath = path.join(SCREENSHOTS_DIR, `${code}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        log('📸', `Screenshot: ${screenshotPath}`);

        if (!priceData) {
          // Salva também o HTML para análise dos seletores
          const html = await page.content().catch(() => '');
          fs.writeFileSync(
            path.join(SCREENSHOTS_DIR, `${code}.html`),
            html,
            'utf8',
          );
          log('💾', `HTML salvo: ${code}.html`);
        }
      }

      // ── Resultado ────────────────────────────────────────────────────
      if (priceData) {
        results[code] = {
          currency,
          amount:    priceData.amount,
          formatted: priceData.raw,
          locale,
          name,
        };
        console.log(`  ✅ ${priceData.raw} (${priceData.amount})`);
      } else {
        warn(`Nenhum preço coletado para ${name} (${code}).`);
        warn(`→ Rode com DEBUG=true e analise o screenshot ${code}.png`);
        errors.push({ country: code, reason: 'Preço não encontrado com nenhuma estratégia' });
      }

    } catch (err) {
      console.error(`  ❌ Erro em ${code}:`, err.message);
      errors.push({ country: code, reason: err.message });

      if (DEBUG) {
        await page.screenshot({
          path:     path.join(SCREENSHOTS_DIR, `${code}-ERROR.png`),
          fullPage: true,
        }).catch(() => {});
      }
    } finally {
      await page.close();
    }

    // Pausa entre países para evitar bloqueio por rate-limiting
    await randomDelay(1000, 2500);
  }

  await browser.close();

  // ── Salva JSON ────────────────────────────────────────────────────────────

  const output = {
    updatedAt:       new Date().toISOString(),
    checkoutUrl:     CHECKOUT_URL,
    strategy:        STRATEGY,
    totalCountries:  Object.keys(results).length,
    prices:          results,
    errors:          errors.length > 0 ? errors : undefined,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  // ── Resumo final ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(56));
  console.log(`✅ Coletados : ${Object.keys(results).length}/${COUNTRIES.length} países`);
  if (errors.length > 0) {
    console.warn(`⚠️  Falhas   : ${errors.length} países`);
    errors.forEach(e => console.warn(`   - ${e.country}: ${e.reason}`));
    console.log('\n💡 DICAS PARA FALHAS:');
    console.log('   1. Rode com DEBUG=true e analise os screenshots');
    console.log('   2. Identifique o seletor CSS no HTML salvo');
    console.log('   3. Defina PRICE_SELECTOR e/ou COUNTRY_BTN_SELECTOR');
    console.log('   4. Rode novamente para confirmar');
  }
  console.log(`📄 Arquivo   : ${OUTPUT_PATH}`);
  console.log('═'.repeat(56) + '\n');

  if (Object.keys(results).length === 0) {
    console.error('❌ Nenhum preço coletado. Verifique a URL e rode com DEBUG=true.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
