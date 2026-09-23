# Agenda do projetor escolar

Agenda compartilhada em português, adaptada ao celular. As reservas são confirmadas diretamente, sem aprovação da coordenação. Requer Node.js 24 ou superior; não usa pacotes externos.

## Recursos e proteção

- Professores consultam todas as reservas e só alteram ou cancelam as próprias.
- Convites individuais vinculados ao e-mail, de uso único, válidos por 48 horas. Emitir outro convite para o mesmo e-mail invalida o anterior. O antigo SCHOOL_INVITE_CODE não é aceito.
- Painel exclusivo da coordenação para emitir convites, desativar/reativar contas e consultar os últimos 100 eventos do histórico.
- Desativar uma conta encerra suas sessões. Suas reservas são preservadas; não há cancelamento silencioso.
- Recuperação de senha por código de uso único, válido por 30 minutos, emitido pela coordenação. A coordenação deve verificar a identidade e entregar o código por um canal privado. Não há envio automático por e-mail. Novo código invalida o anterior; redefinir a senha encerra todas as sessões.
- Senhas novas exigem 12 a 128 caracteres e são protegidas com scrypt. Senhas antigas continuam funcionando, para preservar acessos existentes.
- Sessões de oito horas, cookies HttpOnly/SameSite e tokens armazenados como hashes. Convites e códigos de recuperação também ficam como hashes; não são gravados no histórico.
- Limites persistentes de autenticação: 10 tentativas por e-mail e 100 por endereço de conexão em 15 minutos. Sucesso limpa o contador do e-mail. Atrás de um proxy, o limite de conexão é compartilhado; cabeçalhos de IP enviados pelo cliente não são confiados. Ajuste a proteção do proxy ao tamanho da escola.
- Proteção de origem nas alterações, política de conteúdo, validação de entradas e consultas parametrizadas.
- Conflitos são impedidos no SQLite, inclusive para solicitações simultâneas. Reservas consecutivas são permitidas. Horário de Brasília.
- Histórico transacional de criação, edição e cancelamento, contas, convites e recuperação. Alterações de reservas guardam estado anterior e novo no banco; o painel apresenta um resumo. O histórico começa na atualização, sem inventar eventos anteriores.

## Executar localmente

```sh
npm start
```

Abra http://localhost:3000. A porta pode ser alterada por PORT. O servidor escuta apenas em 127.0.0.1 por padrão. O banco persistente fica em data/agenda.sqlite.

### Primeira coordenação

Com o servidor iniciado, o responsável pela instalação executa em outro terminal:

```sh
node manage.js invite coordenacao@escola.example
```

Entregue o convite exibido apenas ao titular desse e-mail. Ele cria sua conta pela página de cadastro. Depois, o responsável concede o perfil administrativo:

```sh
node manage.js admin coordenacao@escola.example
```

A pessoa entra novamente para ver o painel. Cadastros públicos nunca concedem privilégios de coordenação. A promoção só está disponível no terminal do servidor. Em instalações existentes, use o e-mail exato da conta escolhida. Nenhuma conta recebe privilégios automaticamente pela ordem de cadastro.

A atualização preserva contas e reservas e encerra as sessões antigas uma vez, na migração para tokens protegidos. Faça backup antes de atualizar. Contas e credenciais de demonstração não devem ser levadas à produção.

## HTTPS e publicação

Execute uma instância, com disco persistente, atrás de um proxy HTTPS. O arquivo Caddyfile.example oferece um ponto de partida. Substitua o domínio, configure DNS e libere no servidor as portas necessárias para o proxy; mantenha a porta Node restrita à interface local. O Caddy pode emitir e renovar certificados conforme sua [documentação oficial](https://caddyserver.com/docs/automatic-https).

No PowerShell:

```powershell
$env:NODE_ENV = 'production'
$env:PUBLIC_ORIGIN = 'https://agenda.sua-escola.example'
$env:BACKUP_DIR = 'D:\BackupsAgenda'
npm start
```

No Linux:

```sh
NODE_ENV=production PUBLIC_ORIGIN=https://agenda.sua-escola.example BACKUP_DIR=/var/backups/agenda npm start
```

PUBLIC_ORIGIN deve ser a origem exata, sem caminho nem barra final. Em produção, a aplicação exige uma origem HTTPS, usa cookies Secure e envia HSTS. O HTTPS em si é terminado pelo proxy: essas variáveis não criam certificado ou domínio. Configure o serviço para reiniciar em falhas e após reinicialização da máquina.

A demonstração localhost usa HTTP; ela não foi publicada. GitHub Pages sozinho não executa esse servidor. Hospedagem, domínio, certificados, armazenamento externo e serviço de e-mail precisam ser configurados antes de anunciar o acesso oficial.

## Backups e restauração

O executável cria um backup ao iniciar e a cada 24 horas enquanto estiver rodando, usando a [API de backup consistente do SQLite no Node](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html). BACKUP_DIR define o destino; por padrão, usa backups/ no projeto. Erros são registrados no console do servidor. Esses backups são locais e não são criptografados pela aplicação: restrinja as permissões da pasta, monitore espaço/erros e configure cópias externas protegidas. Não há exclusão automática de backups.

Backup manual:

```sh
node manage.js backup
```

Para restaurar: pare o servidor; mova toda a pasta data para um local de preservação; crie uma nova pasta data; copie o backup escolhido para data/agenda.sqlite; reinicie o servidor. Não misture o banco restaurado com arquivos -wal/-shm antigos. Como o backup contém o estado da época, invalide sessões, convites e recuperações após restaurar, antes de reabrir o acesso:

```sh
node manage.js invalidate-access
```

Contas e reservas permanecem; os usuários entram novamente e os convites pendentes precisam ser reemitidos. Teste periodicamente a restauração em um ambiente separado. Os testes automatizados abrem o backup e verificam sua integridade e conteúdo.

## Aprovação futura

A aprovação permanece desativada. O modelo distingue confirmed, pending, cancelled e rejected; a fábrica do servidor aceita requireApproval, mas o executável não expõe essa opção. Para ativar no futuro, falta implementar configuração persistente, revisão protegida e mensagens de interface. Reservas confirmadas existentes devem ser preservadas.

## Validação

```sh
npm test
```

Os testes verificam reservas simultâneas, intervalos, propriedade, cancelamento, datas, convites inválidos/expirados/reutilizados, permissões, recuperação de uso único, sessões revogadas, origem indevida, limites de login, configuração HTTPS e backup. Isso não substitui uma auditoria independente nem a validação da hospedagem real.
