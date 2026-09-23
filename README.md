# Agenda do projetor escolar

Aplicação em português, adaptada ao celular, para compartilhar a agenda de um único projetor. As reservas são confirmadas imediatamente, sem aprovação da coordenação.

## Recursos

- Contas individuais com nome, e-mail e senha; cadastro protegido pelo código da escola.
- Consulta por dia, cadastro, edição e cancelamento das próprias reservas.
- Bloqueio de intervalos sobrepostos no banco, inclusive em solicitações simultâneas. Uma reserva pode começar exatamente quando outra termina.
- Banco SQLite central e persistente; as informações não ficam limitadas ao navegador.
- Senhas protegidas com scrypt e sessões com cookie HttpOnly. A agenda é acessível apenas após entrar.
- Horários de Brasília. A página atualiza a agenda a cada 30 segundos; o servidor verifica disponibilidade novamente ao salvar.

## Executar

Requer Node.js 24 ou superior. Não há pacotes externos para instalar.

No PowerShell, dentro da pasta do projeto:

```powershell
$env:SCHOOL_INVITE_CODE = 'substitua-por-um-codigo-privado'
npm start
```

Abra http://localhost:3000. Compartilhe o código escolhido somente com os professores. Não salve o código real no GitHub.

No Linux/macOS:

```sh
SCHOOL_INVITE_CODE='substitua-por-um-codigo-privado' npm start
```

## Acesso por toda a escola

É necessário executar uma única instância em um servidor com disco persistente e disponibilizar HTTPS por um proxy reverso. Configure `HOST=0.0.0.0` quando necessário, `PORT` conforme a hospedagem e `COOKIE_SECURE=true` ao usar HTTPS. Um repositório GitHub ou GitHub Pages sozinho não executa este servidor.

O banco é criado em `data/agenda.sqlite`. Para backup simples e consistente, pare o servidor e copie toda a pasta `data`; para restaurar, reponha essa pasta com o servidor parado. Não use discos temporários nem múltiplas instâncias com bancos separados. O código da escola é obrigatório e deve ter ao menos 12 caracteres.

Esta primeira versão ainda não oferece recuperação de senha por e-mail, painel administrativo ou notificações. A pessoa responsável pela instalação deve definir a hospedagem e o procedimento de suporte às contas antes do uso oficial.

## Aprovação futura

O modelo já distingue `confirmed`, `pending`, `cancelled` e `rejected`. A fábrica do servidor aceita `requireApproval`, desativado por padrão. O executável mantém a confirmação direta; a opção não é exposta aos usuários porque o fluxo de revisão ainda não foi implementado.

Para uma próxima versão: acrescentar papel de coordenador, configuração persistente, tela e rotas protegidas para aprovar/recusar, e adaptar as mensagens da interface. Alterar a configuração deve afetar somente novas solicitações e edições, preservando reservas confirmadas. Os testes verificam a criação de pedidos pendentes, mas não constituem um fluxo completo de aprovação.

## Validação

```sh
npm test
```

Os testes usam um servidor real e banco em memória para verificar autenticação, código de cadastro, concorrência, limites dos intervalos, edição, cancelamento, propriedade da reserva, datas inválidas e a base para pedidos pendentes.
