-- Faturamento: valor por hora por projeto, com padrão e moeda por workspace.
--
-- O valor de um lançamento NÃO é gravado: é calculado na leitura
-- (horas × taxa do projeto, ou a padrão do workspace quando o projeto não tem).
-- Mudar a taxa muda o valor de tudo que já foi lançado — o mesmo comportamento
-- do Clockify, e o que se espera ao corrigir uma taxa digitada errada.

-- NULL = usa a taxa padrão do workspace.
ALTER TABLE "time_project" ADD COLUMN "hourlyRate" real;

CREATE TABLE "time_settings" (
  "workspaceId" text PRIMARY KEY NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  -- Código ISO 4217. Só formatação: não há conversão entre moedas.
  "currency"    text NOT NULL DEFAULT 'BRL',
  "defaultRate" real NOT NULL DEFAULT 0
);
