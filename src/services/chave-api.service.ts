import type { ChaveApi, EscopoChave, PlanoAcesso } from '../generated/prisma/client.js';
import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import {
  decomporChave,
  gerarChave,
  segredoConfere,
  type ParceiroAutenticado,
} from '../domain/chave-api.js';
import { ErroNaoAutenticado, ErroRegraNegocio, ErroSemPermissao, ErroValidacao } from '../domain/erros.js';
import type { UnidadeDeTrabalho } from '../repositories/index.js';

/** Hash fictício: mantém o tempo de resposta igual quando o prefixo não existe. */
const HASH_FICTICIO = '0'.repeat(64);
/** `ultimoUso` é gravado no máximo uma vez por minuto por chave. */
const INTERVALO_REGISTRO_USO_MS = 60_000;

function chaveDTO(c: ChaveApi) {
  return {
    id: c.id,
    prefixo: c.prefixo,
    descricao: c.descricao,
    escopos: c.escopos,
    criadaEm: c.criadaEm.toISOString(),
    expiraEm: c.expiraEm?.toISOString() ?? null,
    revogadaEm: c.revogadaEm?.toISOString() ?? null,
    ultimoUso: c.ultimoUso?.toISOString() ?? null,
  };
}

/**
 * Módulo de chaves de API dentro do serviço de autenticação: emissão,
 * revogação e validação das credenciais dos parceiros externos.
 */
export class ChaveApiService {
  private readonly ultimoRegistroUso = new Map<string, number>();

  constructor(private readonly uow: UnidadeDeTrabalho) {}

  // ----------------------------------------------------------- parceiros

  async criarParceiro(ator: Ator, dados: { nome: string; organizacao: string; plano?: PlanoAcesso }) {
    exigirPermissao(ator, 'parceiro:gerenciar');
    return this.uow.emTransacao(async (repos) => {
      const ehUuid = /^[0-9a-f-]{36}$/i.test(dados.organizacao);
      const org = ehUuid
        ? await repos.organizacoes.buscarPorId(dados.organizacao)
        : await repos.organizacoes.buscarPorCodigo(dados.organizacao.trim().toUpperCase());
      if (!org || !org.ativo) throw new ErroRegraNegocio(`Organização '${dados.organizacao}' inexistente ou inativa`);

      const parceiro = await repos.parceiros.criar({ nome: dados.nome.trim(), organizacaoId: org.id, plano: dados.plano ?? 'BASICO' });
      await repos.historico.registrarJournal({
        operacao: 'CRIAR',
        entidade: 'Parceiro',
        entidadeId: parceiro.id,
        dadosDepois: parceiro,
        usuarioResponsavel: ator.usuario,
      });
      return parceiro;
    });
  }

  async listarParceiros(ator: Ator) {
    exigirPermissao(ator, 'parceiro:gerenciar');
    return this.uow.leitura.parceiros.listar();
  }

  async atualizarParceiro(ator: Ator, id: string, versao: number, dados: { plano?: PlanoAcesso; ativo?: boolean }) {
    exigirPermissao(ator, 'parceiro:gerenciar');
    return this.uow.emTransacao(async (repos) => {
      const antes = await repos.parceiros.buscarOuFalhar(id);
      await repos.parceiros.atualizar(id, versao, {
        ...(dados.plano ? { plano: dados.plano } : {}),
        ...(dados.ativo !== undefined ? { ativo: dados.ativo } : {}),
      });
      const depois = await repos.parceiros.buscarOuFalhar(id);
      await repos.historico.registrarJournal({
        operacao: 'ATUALIZAR',
        entidade: 'Parceiro',
        entidadeId: id,
        dadosAntes: antes,
        dadosDepois: depois,
        usuarioResponsavel: ator.usuario,
      });
      return depois;
    });
  }

  // -------------------------------------------------------------- chaves

  /** Emite uma chave. O valor completo é devolvido UMA única vez. */
  async emitir(ator: Ator, parceiroId: string, dados: { escopos: EscopoChave[]; descricao?: string; validadeDias?: number }) {
    exigirPermissao(ator, 'parceiro:gerenciar');
    const escopos = [...new Set(dados.escopos)];
    if (escopos.length === 0) throw new ErroValidacao('Informe ao menos um escopo');

    return this.uow.emTransacao(async (repos) => {
      const parceiro = await repos.parceiros.buscarOuFalhar(parceiroId);
      if (!parceiro.ativo) throw new ErroRegraNegocio('Parceiro inativo não pode receber chaves');

      const gerada = gerarChave();
      const chave = await repos.parceiros.criarChave({
        parceiroId,
        prefixo: gerada.prefixo,
        hashSegredo: gerada.hashSegredo,
        escopos,
        descricao: dados.descricao?.trim() || null,
        expiraEm: dados.validadeDias ? new Date(Date.now() + dados.validadeDias * 86_400_000) : null,
      });
      await repos.historico.registrarJournal({
        operacao: 'EMITIR_CHAVE_API',
        entidade: 'ChaveApi',
        entidadeId: chave.id,
        dadosDepois: { parceiroId, prefixo: chave.prefixo, escopos, expiraEm: chave.expiraEm },
        usuarioResponsavel: ator.usuario,
      });
      return { ...chaveDTO(chave), chave: gerada.chaveCompleta };
    });
  }

  async listarChaves(ator: Ator, parceiroId: string) {
    exigirPermissao(ator, 'parceiro:gerenciar');
    await this.uow.leitura.parceiros.buscarOuFalhar(parceiroId);
    return (await this.uow.leitura.parceiros.listarChaves(parceiroId)).map(chaveDTO);
  }

  async revogar(ator: Ator, chaveId: string): Promise<void> {
    exigirPermissao(ator, 'parceiro:gerenciar');
    await this.uow.emTransacao(async (repos) => {
      const chave = await repos.parceiros.buscarChaveOuFalhar(chaveId);
      if (chave.revogadaEm) return;
      await repos.parceiros.revogarChave(chaveId);
      await repos.historico.registrarJournal({
        operacao: 'REVOGAR_CHAVE_API',
        entidade: 'ChaveApi',
        entidadeId: chaveId,
        usuarioResponsavel: ator.usuario,
      });
    });
  }

  /** Valida a chave do cabeçalho X-API-Key e monta o contexto do parceiro. */
  async autenticar(chaveBruta: string | undefined): Promise<ParceiroAutenticado> {
    const { prefixo, segredo } = decomporChave(chaveBruta);
    const chave = await this.uow.leitura.parceiros.buscarChavePorPrefixo(prefixo);
    const confere = segredoConfere(segredo, chave?.hashSegredo ?? HASH_FICTICIO);

    if (!chave || !confere) throw new ErroNaoAutenticado('Chave de API inválida');
    if (chave.revogadaEm) throw new ErroNaoAutenticado('Chave de API revogada');
    if (chave.expiraEm && chave.expiraEm.getTime() < Date.now()) throw new ErroNaoAutenticado('Chave de API expirada');
    if (!chave.parceiro.ativo) throw new ErroSemPermissao('Parceiro inativo');

    this.registrarUso(chave.id);
    return {
      parceiroId: chave.parceiroId,
      nome: chave.parceiro.nome,
      organizacaoId: chave.parceiro.organizacaoId,
      plano: chave.parceiro.plano,
      chaveId: chave.id,
      escopos: chave.escopos,
    };
  }

  private registrarUso(chaveId: string) {
    const agora = Date.now();
    if (agora - (this.ultimoRegistroUso.get(chaveId) ?? 0) < INTERVALO_REGISTRO_USO_MS) return;
    this.ultimoRegistroUso.set(chaveId, agora);
    // Não bloqueia a requisição; falha aqui não deve derrubá-la
    this.uow.leitura.parceiros.registrarUso(chaveId, new Date(agora)).catch(() => undefined);
  }
}
