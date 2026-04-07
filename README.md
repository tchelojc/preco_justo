# 🛒 Comparador RJ — Preços de Supermercado

Compara preços dos **10 maiores supermercados do Rio de Janeiro** automaticamente, sem custo algum.

**Arquitetura:** GitHub Pages (frontend) + GitHub Actions (scraper) + Google Apps Script (API) + JSON no GitHub (banco de dados)

---

## 📁 Estrutura do Projeto

```
comparador-rj/
├── dados/
│   ├── produtos_base.json       ← Catálogo de produtos (edite aqui)
│   ├── mercados_rj.json         ← Configuração dos supermercados
│   └── precos_cache/            ← JSONs gerados automaticamente pelo scraper
│       ├── _indice.json
│       ├── prezunic_arroz_tipo1_5kg.json
│       └── ...
├── frontend/
│   ├── index.html               ← Página pública (GitHub Pages)
│   └── app.js                   ← Lógica de comunicação
├── scripts/
│   ├── scraper.js               ← Scraper Node.js
│   └── package.json
├── .github/
│   └── workflows/
│       └── scraper.yml          ← Cron job automático (6h em 6h)
└── Codigo.gs                    ← Google Apps Script (API intermediária)
```

---

## 🚀 Instalação Passo a Passo

### 1. Criar o repositório no GitHub

1. Crie um repositório público chamado `comparador-rj`
2. Suba todos os arquivos deste projeto
3. Vá em **Settings → Pages → Source: `main` / folder: `/frontend`**

Sua URL pública será: `https://SEU_USUARIO.github.io/comparador-rj`

---

### 2. Configurar o Google Apps Script

1. Acesse [script.google.com](https://script.google.com) e clique em **Novo projeto**
2. Copie o conteúdo de `Codigo.gs` e cole no editor
3. Vá em **Projeto → Propriedades do script → Variáveis de ambiente**
4. Adicione:
   - **Nome:** `GITHUB_RAW_BASE`
   - **Valor:** `https://raw.githubusercontent.com/SEU_USUARIO/comparador-rj/main/dados`
5. Clique em **Implantar → Novo implante**
   - Tipo: **App da Web**
   - Executar como: **Eu**
   - Quem tem acesso: **Qualquer pessoa**
6. Copie a **URL do implante** gerada

---

### 3. Configurar o frontend

Abra `frontend/app.js` e substitua na linha 12:

```javascript
// ANTES:
const GAS_URL = 'https://script.google.com/macros/s/SEU_SCRIPT_ID_AQUI/exec';

// DEPOIS (cole sua URL real):
const GAS_URL = 'https://script.google.com/macros/s/AKfyc...SUA_URL_REAL.../exec';
```

Faça o mesmo para `GITHUB_RAW` na linha 15 com seu usuário/repositório.

---

### 4. Testar o scraper localmente (opcional)

```bash
cd scripts
npm install
node scraper.js
```

Os arquivos JSON serão criados em `dados/precos_cache/`.

---

### 5. O scraper roda automaticamente!

O arquivo `.github/workflows/scraper.yml` configura o GitHub Actions para rodar o scraper **a cada 6 horas**. Você pode também rodar manualmente na aba **Actions** do seu repositório.

---

## ➕ Adicionar Produtos

Edite `dados/produtos_base.json` e adicione um objeto seguindo o padrão:

```json
{
  "id": "id_unico_sem_espacos",
  "categoria": "Nome da Categoria",
  "nome_canonico": "Nome que aparece no frontend",
  "embalagem": "500g",
  "unidade_medida": "kg",
  "gtin_possiveis": [],
  "palavras_chave": ["palavra1", "palavra2"]
}
```

---

## ➕ Adicionar Mercados

Edite `dados/mercados_rj.json`:

```json
{
  "id": "id_mercado",
  "nome": "Nome do Mercado",
  "logo": "🛒",
  "cor": "#FF0000",
  "base_url": "https://www.site-do-mercado.com.br",
  "busca_url_template": "/busca?q={TERMO}",
  "container_produto": ".seletor-css-do-card-de-produto",
  "json_ld_esperado": true,
  "plataforma": "vtex",
  "ativo": true
}
```

> **Dica:** Mercados que usam VTEX (Pão de Açúcar, Guanabara, Prezunic) têm JSON-LD automático e funcionam melhor.

---

## 💡 Como Funciona o Fluxo

```
[GitHub Actions — Cron 6h]
        │
        ├── Lê mercados_rj.json + produtos_base.json
        ├── Faz fetch nas páginas de busca de cada mercado
        ├── Extrai preços via JSON-LD (ou DOM como fallback)
        └── Salva JSON em dados/precos_cache/ e faz git push

[Usuário acessa GitHub Pages]
        │
        ├── app.js chama Google Apps Script (?action=precos&produto=arroz...)
        ├── GAS lê os JSONs cacheados no GitHub
        └── Retorna os preços ordenados do menor para o maior
```

---

## 💰 Custo Total: R$ 0,00

| Componente       | Plano Gratuito           |
|------------------|--------------------------|
| GitHub Pages     | Ilimitado (público)      |
| GitHub Actions   | 2.000 min/mês            |
| Google Apps Script | 6 min por execução, 90 min/dia |
| GitHub (JSONs)   | 1GB de storage           |

---

## ⚠️ Observações Importantes

- O scraper é **educado**: espera 1,5–2,5 segundos entre requests para não sobrecarregar os sites
- Mercados que carregam preços via JavaScript pesado podem não ser raspados corretamente — prefira sites com JSON-LD
- Os preços são informativos. Verifique sempre o site oficial antes de comprar
- O Google Apps Script tem cache de 30 minutos interno para economizar chamadas ao GitHub
