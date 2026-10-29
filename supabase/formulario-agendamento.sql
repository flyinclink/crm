-- =====================================================================
-- Busca automática dos envios do Tally que ficaram para trás (de hora em hora)
-- Rode no SQL Editor DEPOIS de publicar a função "formulario-sincronizar".
-- Pode rodar de novo sem problema.
-- =====================================================================

create extension if not exists pg_net;

-- Segredo que prova que a chamada veio do seu próprio banco.
-- É gerado aqui e fica guardado no Vault (cofre do Supabase): ninguém precisa copiá-lo.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'crm_sincronizacao') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'crm_sincronizacao',
      'Segredo da busca automática de envios do formulário');
  end if;
end $$;

-- Aos 17 minutos de cada hora
select cron.schedule('crm-sincronizar-formularios', '17 * * * *', $$
  select net.http_post(
    url     := 'https://nvdhmoyulmdlyfgxhxsd.supabase.co/functions/v1/formulario-sincronizar',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets
                                    where name = 'crm_sincronizacao' limit 1)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000)
$$);

-- Para rodar a busca agora (teste), descomente a linha abaixo:
-- select net.http_post(url := 'https://nvdhmoyulmdlyfgxhxsd.supabase.co/functions/v1/formulario-sincronizar', headers := jsonb_build_object('Content-Type','application/json','x-sync-secret',(select decrypted_secret from vault.decrypted_secrets where name='crm_sincronizacao' limit 1)), body := '{}'::jsonb);
